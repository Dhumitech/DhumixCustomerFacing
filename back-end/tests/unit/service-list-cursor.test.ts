import { describe, expect, it } from "vitest";
import { encodeApiKeyListCursor } from "../../src/helpers/apiKeyListCursor.js";
import {
  decodeServiceListCursor,
  encodeServiceListCursor,
} from "../../src/helpers/serviceListCursor.js";

describe("Service list cursor", () => {
  it("round-trips the canonical versioned Service position", () => {
    const position = {
      createdAt: "2026-08-24T12:00:00.000Z",
      id: "55555555-5555-4555-8555-555555555555",
    } as const;

    const cursor = encodeServiceListCursor(position);

    expect(cursor).toBe(
      Buffer.from(
        JSON.stringify({
          version: 1,
          kind: "services",
          created_at: position.createdAt,
          id: position.id,
        }),
        "utf8",
      ).toString("base64url"),
    );
    expect(decodeServiceListCursor(cursor)).toEqual(position);
  });

  it("rejects malformed, non-canonical, oversized, and operation-mismatched cursors", () => {
    const encoded = (value: unknown) =>
      Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    const apiKeyCursor = encodeApiKeyListCursor({
      createdAt: "2026-08-24T12:00:00.000Z",
      id: "55555555-5555-4555-8555-555555555555",
    });
    const invalid = [
      "",
      "a".repeat(2049),
      "not+base64url",
      `${encoded({ version: 1, kind: "services", created_at: "2026-08-24T12:00:00.000Z", id: "55555555-5555-4555-8555-555555555555" })}=`,
      Buffer.from([0xff]).toString("base64url"),
      encoded(null),
      encoded({ version: 2, kind: "services", created_at: "2026-08-24T12:00:00.000Z", id: "55555555-5555-4555-8555-555555555555" }),
      encoded({ version: 1, kind: "runs", created_at: "2026-08-24T12:00:00.000Z", id: "55555555-5555-4555-8555-555555555555" }),
      encoded({ version: 1, kind: "services", created_at: "not-a-date", id: "55555555-5555-4555-8555-555555555555" }),
      encoded({ version: 1, kind: "services", created_at: "2026-08-24T12:00:00Z", id: "55555555-5555-4555-8555-555555555555" }),
      encoded({ version: 1, kind: "services", created_at: "2026-08-24T12:00:00.000Z", id: "not-a-uuid" }),
      encoded({ version: 1, kind: "services", created_at: "2026-08-24T12:00:00.000Z", id: "55555555-5555-4555-8555-555555555555", tenant_id: "secret" }),
      encoded({ kind: "services", version: 1, created_at: "2026-08-24T12:00:00.000Z", id: "55555555-5555-4555-8555-555555555555" }),
      apiKeyCursor,
    ];

    for (const cursor of invalid) {
      expect(() => decodeServiceListCursor(cursor)).toThrow(TypeError);
    }
  });

  it("rejects invalid positions before encoding", () => {
    expect(() =>
      encodeServiceListCursor({ createdAt: "not-a-date", id: "not-a-uuid" }),
    ).toThrow(TypeError);
  });
});
