import { describe, expect, it } from "vitest";
import {
  decodeApiKeyListCursor,
  encodeApiKeyListCursor,
} from "../../src/helpers/apiKeyListCursor.js";

describe("API-key list cursor", () => {
  it("round-trips the canonical versioned API-key position", () => {
    const position = {
      createdAt: "2026-08-24T00:00:00.000Z",
      id: "55555555-5555-4555-8555-555555555555",
    } as const;

    const cursor = encodeApiKeyListCursor(position);

    expect(cursor).toBe(
      Buffer.from(
        JSON.stringify({
          version: 1,
          kind: "api_keys",
          created_at: position.createdAt,
          id: position.id,
        }),
        "utf8",
      ).toString("base64url"),
    );
    expect(decodeApiKeyListCursor(cursor)).toEqual(position);
  });

  it("rejects malformed, non-canonical, or operation-mismatched cursors", () => {
    const encoded = (value: unknown) =>
      Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    const invalid = [
      "",
      "not+base64url",
      `${encoded({ version: 1, kind: "api_keys", created_at: "2026-08-24T00:00:00.000Z", id: "55555555-5555-4555-8555-555555555555" })}=`,
      Buffer.from([0xff]).toString("base64url"),
      encoded(null),
      encoded({ version: 2, kind: "api_keys", created_at: "2026-08-24T00:00:00.000Z", id: "55555555-5555-4555-8555-555555555555" }),
      encoded({ version: 1, kind: "runs", created_at: "2026-08-24T00:00:00.000Z", id: "55555555-5555-4555-8555-555555555555" }),
      encoded({ version: 1, kind: "api_keys", created_at: "not-a-date", id: "55555555-5555-4555-8555-555555555555" }),
      encoded({ version: 1, kind: "api_keys", created_at: "2026-08-24T00:00:00.000Z", id: "not-a-uuid" }),
      encoded({ version: 1, kind: "api_keys", created_at: "2026-08-24T00:00:00.000Z", id: "55555555-5555-4555-8555-555555555555", tenant_id: "secret" }),
      encoded({ kind: "api_keys", version: 1, created_at: "2026-08-24T00:00:00.000Z", id: "55555555-5555-4555-8555-555555555555" }),
    ];

    for (const cursor of invalid) {
      expect(() => decodeApiKeyListCursor(cursor)).toThrow(TypeError);
    }
  });
});
