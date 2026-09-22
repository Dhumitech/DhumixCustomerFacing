import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "./SessionProvider";
import { tokenStore } from "./tokenStore";
import { useSession } from "./useSession";

const session = {
  access_token: "access-token-1",
  token_type: "Bearer" as const,
  expires_in: 100,
  csrf_token: "csrf-token-1",
};

function SessionProbe() {
  const { session: current } = useSession();
  return <output>{current?.access_token ?? "signed-out"}</output>;
}

afterEach(() => {
  tokenStore.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("active browser session refresh", () => {
  it("refreshes before expires_in elapses and stores the rotated session", async () => {
    vi.useFakeTimers();
    tokenStore.set(session, "customer@example.test");
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            ...session,
            access_token: "access-token-2",
            csrf_token: "csrf-token-2",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <SessionProvider>
        <SessionProbe />
      </SessionProvider>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(89_999);
    });
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const request = fetchMock.mock.calls[0][0] as Request;
    expect(request.url).toBe("http://localhost:3000/v1/auth/refresh");
    expect(request.method).toBe("POST");
    expect(request.headers.get("X-CSRF-Token")).toBe("csrf-token-1");
    expect(request.credentials).toBe("include");
    expect(screen.getByText("access-token-2")).toBeInTheDocument();
    expect(tokenStore.getIdentitySnapshot()).toBe("customer@example.test");
  });

  it("clears an active session when refresh is rejected", async () => {
    vi.useFakeTimers();
    tokenStore.set(session, "customer@example.test");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({
              type: "about:blank",
              title: "Authentication required",
              status: 401,
              code: "AUTHENTICATION_REQUIRED",
              request_id: "request-12345678",
            }),
            { status: 401, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    render(
      <SessionProvider>
        <SessionProbe />
      </SessionProvider>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });

    expect(screen.getByText("signed-out")).toBeInTheDocument();
    expect(tokenStore.getIdentitySnapshot()).toBeNull();
  });

  it("clears the session at expiry after bounded transient refresh failures", async () => {
    vi.useFakeTimers();
    tokenStore.set(session, "customer@example.test");
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new TypeError("temporary network failure");
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <SessionProvider>
        <SessionProbe />
      </SessionProvider>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(screen.getByText("access-token-1")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText("signed-out")).toBeInTheDocument();
  });
});
