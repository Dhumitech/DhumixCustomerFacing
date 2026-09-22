import { afterEach, describe, expect, it, vi } from "vitest";
import { tokenStore } from "../session/tokenStore";
import { runsApi } from "./customerRuns";

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

afterEach(() => {
  tokenStore.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("customer Run mutation idempotency", () => {
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
