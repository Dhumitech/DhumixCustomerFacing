import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Run, RunStatus } from "../../api/generated";
import {
  SessionContext,
  type SessionContextValue,
} from "../../session/SessionProvider";
import { tokenStore } from "../../session/tokenStore";
import { CurrentRunPanel } from "./components/CurrentRunPanel";
import { RunsWorkspacePage } from "./RunsWorkspacePage";

const authSession = {
  access_token: "access-token",
  token_type: "Bearer" as const,
  expires_in: 3600,
  csrf_token: "csrf-token",
};

function run(status: RunStatus, retryable = false): Run {
  return {
    id: "run-1",
    service_id: "service-1",
    status,
    retryable,
    created_at: "2026-09-05T00:00:00.000Z",
    updated_at: "2026-09-05T00:00:01.000Z",
    ...(status === "ready" ? { completed_at: "2026-09-05T00:00:01.000Z" } : {}),
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function lifecycleFetch(statuses: readonly RunStatus[]) {
  let runReads = 0;
  return vi.fn<typeof fetch>(async (input) => {
    const request = input as Request;
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/v1/runs/run-1" && request.method === "GET") {
      const status =
        statuses[Math.min(runReads, statuses.length - 1)] ?? "queued";
      runReads += 1;
      return json(run(status, status === "failed"));
    }
    if (path === "/v1/runs/run-1/events") {
      return json({ data: [], page: { next_cursor: null, has_more: false } });
    }
    if (path === "/v1/runs/run-1/cancel" && request.method === "POST") {
      return json(run("cancelled"), 202);
    }
    if (path === "/v1/runs/run-1/retry" && request.method === "POST") {
      return json(
        {
          run_id: "run-2",
          status: "queued",
          accepted_at: "2026-09-05T00:00:02.000Z",
        },
        202,
      );
    }
    if (path === "/v1/runs/run-1/result") {
      const representation = url.searchParams.get("representation");
      return json({
        run_id: "run-1",
        content_type: "application/json",
        byte_count: 27,
        checksum: "a".repeat(64),
        download_url: `http://127.0.0.1:10000/results/signed-${representation}`,
        download_expires_at: "2026-09-05T00:05:00.000Z",
      });
    }
    return json({});
  });
}

const session: SessionContextValue = {
  session: authSession,
  identityEmail: "customer@example.test",
  isAuthenticated: true,
  signUp: vi.fn(),
  signIn: vi.fn(),
  refresh: vi.fn(),
  logout: vi.fn(),
};

function renderPanel(onRetried = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    onRetried,
    ...render(
      <QueryClientProvider client={queryClient}>
        <SessionContext.Provider value={session}>
          <MemoryRouter>
            <CurrentRunPanel
              runId="run-1"
              serviceName="My Amazon Products Scraper"
              operationName="Collect by URL"
              onClose={vi.fn()}
              onRetried={onRetried}
            />
          </MemoryRouter>
        </SessionContext.Provider>
      </QueryClientProvider>,
    ),
  };
}

function renderRunsWorkspace() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <SessionContext.Provider value={session}>
        <MemoryRouter initialEntries={["/workspace/runs"]}>
          <RunsWorkspacePage />
        </MemoryRouter>
      </SessionContext.Provider>
    </QueryClientProvider>,
  );
}

function mutationRequest(fetchMock: ReturnType<typeof vi.fn>, suffix: string) {
  return fetchMock.mock.calls
    .map(([input]) => input as Request)
    .find(
      (request) =>
        request.method === "POST" &&
        new URL(request.url).pathname.endsWith(suffix),
    );
}

beforeEach(() => {
  window.history.replaceState(null, "", "/o/11111111-1111-4111-8111-111111111111/workspace/runs");
  tokenStore.set(authSession, "customer@example.test");
});

afterEach(() => {
  window.history.replaceState(null, "", "/");
  tokenStore.clear();
  sessionStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("customer Run lifecycle controls", () => {
  it.each(["failed", "cancelled", "expired"] as const)(
    "stops Run and event polling after %s",
    async (terminal) => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const fetchMock = lifecycleFetch(["running", terminal]);
      vi.stubGlobal("fetch", fetchMock);
      renderPanel();
      expect(await screen.findByText("Running")).toBeInTheDocument();
      await act(async () => vi.advanceTimersByTimeAsync(2100));
      expect(
        await screen.findByText(terminal[0].toUpperCase() + terminal.slice(1)),
      ).toBeInTheDocument();
      await act(async () => vi.advanceTimersByTimeAsync(100));
      const count = fetchMock.mock.calls.length;
      await act(async () => vi.advanceTimersByTimeAsync(5000));
      expect(fetchMock.mock.calls).toHaveLength(count);
    },
  );
  it.each([
    [
      "ALL_INPUTS_FAILED",
      "No inputs could be collected. The collection has failed.",
    ],
    ["PROVIDER_TIMEOUT", "The collection exceeded its processing deadline."],
  ])("displays the Dhumi %s message", async (errorCode, message) => {
    const base = lifecycleFetch(["failed"]);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        if (new URL((input as Request).url).pathname === "/v1/runs/run-1")
          return json({ ...run("failed"), error_code: errorCode });
        return base(input, init);
      }),
    );
    renderPanel();
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Prepare normalized download" }),
    ).not.toBeInTheDocument();
  });
  it("reconnects by reading the Run without submitting a mutation", async () => {
    let reachable = false;
    const base = lifecycleFetch(["failed"]);
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      if (!reachable) throw new TypeError("offline");
      return base(input, init);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPanel();
    const reconnect = await screen.findByRole("button", { name: "Reconnect" });
    reachable = true;
    await userEvent.setup().click(reconnect);
    expect(await screen.findByText("Failed")).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.every(
        ([input]) => (input as Request).method === "GET",
      ),
    ).toBe(true);
  });
  it("cancels an active Run through the authenticated mutation contract", async () => {
    const user = userEvent.setup();
    const fetchMock = lifecycleFetch(["running"]);
    vi.stubGlobal("fetch", fetchMock);
    renderPanel();

    await user.click(
      await screen.findByRole("button", {
        name: "Cancel collection",
      }),
    );

    await waitFor(() =>
      expect(mutationRequest(fetchMock, "/cancel")).toBeDefined(),
    );
    const request = mutationRequest(fetchMock, "/cancel");
    expect(request?.headers.get("Idempotency-Key")).toMatch(
      /^frontend\.run\.cancel\./,
    );
    expect(request?.headers.get("X-CSRF-Token")).toBe("csrf-token");
  });

  it("retries only an eligible failed Run and selects the accepted successor", async () => {
    const user = userEvent.setup();
    const fetchMock = lifecycleFetch(["failed"]);
    vi.stubGlobal("fetch", fetchMock);
    const onRetried = vi.fn();
    renderPanel(onRetried);

    await user.click(
      await screen.findByRole("button", {
        name: "Retry collection",
      }),
    );

    await waitFor(() => expect(onRetried).toHaveBeenCalledWith("run-2"));
    expect(
      mutationRequest(fetchMock, "/retry")?.headers.get("Idempotency-Key"),
    ).toMatch(/^frontend\.run\.retry\./);
  });

  it("authorizes normalized and raw results independently", async () => {
    const user = userEvent.setup();
    const fetchMock = lifecycleFetch(["ready"]);
    vi.stubGlobal("fetch", fetchMock);
    renderPanel();

    await user.click(
      await screen.findByRole("button", {
        name: "Prepare normalized download",
      }),
    );

    expect(
      await screen.findByRole("link", { name: "Download normalized" }),
    ).toHaveAttribute(
      "href",
      "http://127.0.0.1:10000/results/signed-normalized",
    );
    expect(
      screen.getByText("Normalized JSON is ready · 27 B"),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Prepare raw download" }),
    );
    expect(
      await screen.findByRole("link", { name: "Download raw" }),
    ).toHaveAttribute("href", "http://127.0.0.1:10000/results/signed-raw");
    expect(screen.getByText("Raw JSON is ready · 27 B")).toBeInTheDocument();

    const resultRepresentations = fetchMock.mock.calls
      .map(([input]) => new URL((input as Request).url))
      .filter((url) => url.pathname === "/v1/runs/run-1/result")
      .map((url) => url.searchParams.get("representation"));
    expect(resultRepresentations).toEqual(["normalized", "raw"]);
  });

  it("clears signed links when the selected Run changes", async () => {
    const user = userEvent.setup();
    const first = { ...run("ready"), id: "run-1", service_id: "service-1" };
    const second = { ...run("ready"), id: "run-2", service_id: "service-2" };
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const request = input as Request;
      const url = new URL(request.url);
      if (url.pathname === "/v1/runs") {
        return json({
          data: [first, second],
          page: { next_cursor: null, has_more: false },
        });
      }
      if (url.pathname === "/v1/services") {
        return json({
          data: [
            { id: "service-1", name: "First scraper" },
            { id: "service-2", name: "Second scraper" },
          ],
          page: { next_cursor: null, has_more: false },
        });
      }
      if (url.pathname.endsWith("/events")) {
        return json({ data: [], page: { next_cursor: null, has_more: false } });
      }
      if (url.pathname.endsWith("/result")) {
        const runId = url.pathname.split("/")[3];
        return json({
          run_id: runId,
          content_type: "application/json",
          byte_count: 27,
          checksum: "a".repeat(64),
          download_url: `http://127.0.0.1:10000/results/${runId}`,
          download_expires_at: "2026-09-05T00:05:00.000Z",
        });
      }
      if (url.pathname === "/v1/runs/run-1") return json(first);
      if (url.pathname === "/v1/runs/run-2") return json(second);
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    renderRunsWorkspace();

    await user.click(
      await screen.findByRole("button", { name: /First scraper/ }),
    );
    await user.click(
      await screen.findByRole("button", {
        name: "Prepare normalized download",
      }),
    );
    expect(
      await screen.findByRole("link", { name: "Download normalized" }),
    ).toHaveAttribute("href", "http://127.0.0.1:10000/results/run-1");

    await user.click(screen.getByRole("button", { name: /Second scraper/ }));
    expect(
      await screen.findByRole("button", {
        name: "Prepare normalized download",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Download normalized" }),
    ).not.toBeInTheDocument();
  });

  it("polls non-terminal Runs and stops after ready", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = lifecycleFetch(["queued", "running", "ready"]);
    vi.stubGlobal("fetch", fetchMock);
    renderPanel();

    expect(await screen.findByText("Queued")).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(2_100));
    expect(await screen.findByText("Running")).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(2_100));
    expect(await screen.findByText("Ready")).toBeInTheDocument();

    const readyReadCount = fetchMock.mock.calls.filter(
      ([input]) =>
        new URL((input as Request).url).pathname === "/v1/runs/run-1",
    ).length;
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(
      fetchMock.mock.calls.filter(
        ([input]) =>
          new URL((input as Request).url).pathname === "/v1/runs/run-1",
      ),
    ).toHaveLength(readyReadCount);
  });
});
