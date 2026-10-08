import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tokenStore } from "../session/tokenStore";
import { runsApi, serviceExecutionApi } from "./customerRuns";

const session = {
  access_token: "browser-access-token",
  token_type: "Bearer" as const,
  expires_in: 3600,
  csrf_token: "browser-csrf-token-value",
};

function accepted(runId: string): Response {
  return new Response(
    JSON.stringify({
      run_id: runId,
      status: "queued",
      accepted_at: "2026-09-05T00:00:00.000Z",
    }),
    {
      status: 202,
      headers: { "Content-Type": "application/json" },
    },
  );
}

function requestAt(mock: ReturnType<typeof vi.fn>, index: number): Request {
  return mock.mock.calls[index]?.[0] as Request;
}

beforeEach(() => { window.history.replaceState(null, "", "/o/11111111-1111-4111-8111-111111111111/workspace/scrapers"); });

afterEach(() => {
  window.history.replaceState(null, "", "/");
  tokenStore.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("customer Run mutation idempotency", () => {
  it("supplies required browser CSRF and idempotency when saving a Service", async () => {
    tokenStore.set(session);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("{}", {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await serviceExecutionApi.create({
      templateSlug: "fixture-scraper",
      name: "Saved scraper",
      configuration: {},
    });
    const request = requestAt(fetchMock, 0);
    expect(request.headers.get("Authorization")).toBe(
      `Bearer ${session.access_token}`,
    );
    expect(request.headers.get("X-CSRF-Token")).toBe(session.csrf_token);
    expect(request.headers.get("Idempotency-Key")).toMatch(
      /^frontend\.service\.create\./,
    );
  });
  it.each(["create", "cancel", "retry"] as const)(
    "sends browser authentication and CSRF for %s",
    async (operation) => {
      tokenStore.set(session);
      const response =
        operation === "cancel"
          ? new Response(
              JSON.stringify({
                id: "run-1",
                service_id: "service-1",
                status: "queued",
                error_code: null,
                retryable: false,
                created_at: "2026-10-06T00:00:00.000Z",
                updated_at: "2026-10-06T00:00:00.000Z",
                completed_at: null,
              }),
              { status: 202, headers: { "Content-Type": "application/json" } },
            )
          : accepted("run-1");
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
      vi.stubGlobal("fetch", fetchMock);
      if (operation === "create")
        await runsApi.create("service-1", { query: "laptop" });
      else if (operation === "cancel") await runsApi.cancel("run-1");
      else await runsApi.retry("run-1");
      const request = requestAt(fetchMock, 0);
      expect(request.headers.get("Authorization")).toBe(
        `Bearer ${session.access_token}`,
      );
      expect(request.headers.get("X-CSRF-Token")).toBe(session.csrf_token);
      expect(request.headers.get("Idempotency-Key")).toMatch(
        new RegExp(`^frontend\\.run\\.${operation}\\.`),
      );
    },
  );

  it("reuses one key after an ambiguous network failure and rotates it after success", async () => {
    tokenStore.set(session);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(accepted("run-1"))
      .mockResolvedValueOnce(accepted("run-2"));
    vi.stubGlobal("fetch", fetchMock);
    const input = {
      targets: [{ url: "https://www.amazon.com/dp/B00TEST001" }],
    };

    await expect(runsApi.create("service-1", input)).rejects.toThrow();
    await expect(runsApi.create("service-1", input)).resolves.toMatchObject({
      run_id: "run-1",
    });

    const firstKey = requestAt(fetchMock, 0).headers.get("Idempotency-Key");
    const retryKey = requestAt(fetchMock, 1).headers.get("Idempotency-Key");
    expect(firstKey).toMatch(/^frontend\.run\.create\./);
    expect(retryKey).toBe(firstKey);

    await runsApi.create("service-1", input);
    expect(requestAt(fetchMock, 2).headers.get("Idempotency-Key")).not.toBe(
      firstKey,
    );
  });

  it("uses different keys for different logical Run payloads", async () => {
    tokenStore.set(session);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      runsApi.create("service-1", {
        targets: [{ url: "https://www.amazon.com/dp/B00TEST001" }],
      }),
    ).rejects.toThrow();
    await expect(
      runsApi.create("service-1", {
        targets: [{ url: "https://www.amazon.com/dp/B00TEST002" }],
      }),
    ).rejects.toThrow();

    expect(requestAt(fetchMock, 0).headers.get("Idempotency-Key")).not.toBe(
      requestAt(fetchMock, 1).headers.get("Idempotency-Key"),
    );
  });
});

describe("customer Run result representations", () => {
  it.each(["normalized", "raw"] as const)(
    "sends the explicit %s representation",
    async (representation) => {
      tokenStore.set(session);
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            run_id: "run-1",
            content_type: "application/json",
            byte_count: 2,
            checksum: "a".repeat(64),
            download_url: "https://downloads.example.test/result",
            download_expires_at: "2026-09-09T12:00:00.000Z",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
      vi.stubGlobal("fetch", fetchMock);

      await runsApi.result({ runId: "run-1", representation });

      const url = new URL(requestAt(fetchMock, 0).url);
      expect(url.pathname).toBe("/v1/runs/run-1/result");
      expect(url.searchParams.get("representation")).toBe(representation);
    },
  );
});
