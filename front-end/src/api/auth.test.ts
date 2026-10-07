import { afterEach, describe, expect, it, vi } from "vitest";
import { tokenStore } from "../session/tokenStore";
import { authApi } from "./auth";

// Unit requests use fixed public metadata and never depend on a local .env.
vi.mock("../config/runtime", () => ({
  runtimeConfig: {
    apiOrigin: "http://localhost:3000",
    signupLegalAcceptances: [
      {
        document_type: "terms_of_service",
        document_version: "2026-09-01",
        content_hash: "a".repeat(64),
        accepted: true,
      },
    ],
  },
}));

const session = {
  access_token: "browser-access-token",
  token_type: "Bearer" as const,
  expires_in: 3600,
  csrf_token: "browser-csrf-token-value",
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  tokenStore.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("central Dhumi authentication client", () => {
  it("ignores the historical company field and supplies signup policy headers", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse(
        {
          accepted: true,
          message: "Account request accepted. Sign in to continue.",
        },
        202,
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await authApi.signUp({
      companyNameOrWebsite: "Acme Research",
      email: "customer@example.test",
      password: "a-sufficiently-long-password",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0][0] as Request;
    expect(request.url).toBe("http://localhost:3000/v1/auth/signup");
    expect(request.method).toBe("POST");
    expect(request.credentials).toBe("include");
    expect(request.headers.get("Idempotency-Key")).toMatch(
      /^frontend\.auth\.signup\.[0-9a-f-]{36}$/,
    );
    expect(await request.json()).toEqual({
      email: "customer@example.test",
      password: "a-sufficiently-long-password",
      legal_acceptances: [
        {
          document_type: "terms_of_service",
          document_version: "2026-09-01",
          content_hash: "a".repeat(64),
          accepted: true,
        },
      ],
    });
  });

  it("reuses the signup idempotency key after an uncertain failure", async () => {
    const requests: Request[] = [];
    let attempts = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const request = input as Request;
      requests.push(request);
      attempts += 1;
      if (attempts === 1) {
        return jsonResponse(
          {
            type: "about:blank",
            title: "Service unavailable",
            status: 503,
            code: "SERVICE_UNAVAILABLE",
            request_id: "request-1",
          },
          503,
        );
      }
      return jsonResponse(
        {
          accepted: true,
          message: "Account request accepted. Sign in to continue.",
        },
        202,
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const input = {
      companyNameOrWebsite: "Acme Research",
      email: "retry@example.test",
      password: "a-sufficiently-long-password",
    };

    await expect(authApi.signUp(input)).rejects.toMatchObject({ status: 503 });
    await expect(authApi.signUp(input)).resolves.toMatchObject({
      accepted: true,
    });

    expect(requests).toHaveLength(2);
    expect(requests[1]?.headers.get("Idempotency-Key")).toBe(
      requests[0]?.headers.get("Idempotency-Key"),
    );
  });

  it("stores a successful sign-in session in memory and never browser storage", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse(session, 200),
    );
    vi.stubGlobal("fetch", fetchMock);
    const localStorageSpy = vi.spyOn(Storage.prototype, "setItem");

    await authApi.signIn({
      email: "customer@example.test",
      password: "a-sufficiently-long-password",
    });

    const request = fetchMock.mock.calls[0][0] as Request;
    expect(request.url).toBe("http://localhost:3000/v1/auth/sign-in");
    expect(request.credentials).toBe("include");
    expect(tokenStore.getSnapshot()).toEqual(session);
    expect(tokenStore.getIdentitySnapshot()).toBe("customer@example.test");
    expect(localStorageSpy).not.toHaveBeenCalled();
  });

  it("attaches bearer and CSRF values from memory when logging out", async () => {
    tokenStore.set(session);
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 204 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await authApi.logout();

    const request = fetchMock.mock.calls[0][0] as Request;
    expect(request.headers.get("Authorization")).toBe(
      "Bearer browser-access-token",
    );
    expect(request.headers.get("X-CSRF-Token")).toBe(
      "browser-csrf-token-value",
    );
    expect(tokenStore.getSnapshot()).toBeNull();
  });

  it("does not restore a session when logout wins an in-flight refresh race", async () => {
    tokenStore.set(session);
    let completeRefresh: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        () =>
          new Promise<Response>((resolve) => {
            completeRefresh = resolve;
          }),
      ),
    );

    const refresh = authApi.refresh();
    await vi.waitFor(() => expect(completeRefresh).toBeTypeOf("function"));
    tokenStore.clear();
    completeRefresh?.(
      jsonResponse(
        { ...session, access_token: "stale-rotated-access-token" },
        200,
      ),
    );
    await refresh;

    expect(tokenStore.getSnapshot()).toBeNull();
  });

  it("preserves a safe backend problem as a typed frontend error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            type: "about:blank",
            title: "Authentication required",
            status: 401,
            code: "AUTHENTICATION_REQUIRED",
            request_id: "request-12345678",
          },
          401,
        ),
      ),
    );

    const outcome = authApi.signIn({
      email: "customer@example.test",
      password: "wrong-password",
    });

    await expect(outcome).rejects.toMatchObject({
      status: 401,
      code: "AUTHENTICATION_REQUIRED",
      requestId: "request-12345678",
    });
  });
});
