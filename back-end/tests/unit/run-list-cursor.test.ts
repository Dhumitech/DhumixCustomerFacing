import { describe, expect, it } from "vitest";
import { encodeServiceListCursor } from "../../src/helpers/serviceListCursor.js";
import {
  decodeRunListCursor,
  encodeRunListCursor,
} from "../../src/helpers/runListCursor.js";

describe("Run list cursor", () => {
  it("round-trips the canonical versioned position and status filter", () => {
    const position = {
      statusFilter: "queued",
      serviceIdFilter: "66666666-6666-4666-8666-666666666666",
      createdAt: "2026-08-25T12:00:00.000Z",
      id: "55555555-5555-4555-8555-555555555555",
    } as const;

    const cursor = encodeRunListCursor(position);

    expect(cursor).toBe(
      Buffer.from(
        JSON.stringify({
          version: 2,
          kind: "runs",
          status_filter: position.statusFilter,
          service_id_filter: position.serviceIdFilter,
          created_at: position.createdAt,
          id: position.id,
        }),
        "utf8",
      ).toString("base64url"),
    );
    expect(decodeRunListCursor(cursor)).toEqual(position);
  });

  it("round-trips the canonical all-status position", () => {
    const position = {
      statusFilter: null,
      serviceIdFilter: null,
      createdAt: "2026-08-25T12:00:00.000Z",
      id: "55555555-5555-4555-8555-555555555555",
    } as const;

    expect(decodeRunListCursor(encodeRunListCursor(position))).toEqual(position);
  });

  it("rejects malformed, non-canonical, oversized, and operation-mismatched cursors", () => {
    const encoded = (value: unknown) =>
      Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    const serviceCursor = encodeServiceListCursor({
      createdAt: "2026-08-25T12:00:00.000Z",
      id: "55555555-5555-4555-8555-555555555555",
    });
    const valid = {
      version: 1,
      kind: "runs",
      status_filter: "queued",
      created_at: "2026-08-25T12:00:00.000Z",
      id: "55555555-5555-4555-8555-555555555555",
    } as const;
    const invalid = [
      "",
      "a".repeat(2049),
      "not+base64url",
      `${encoded(valid)}=`,
      Buffer.from([0xff]).toString("base64url"),
      encoded(null),
      encoded({ ...valid, version: 3 }),
      encoded({ ...valid, kind: "services" }),
      encoded({ ...valid, status_filter: "private-status" }),
      encoded({ ...valid, status_filter: undefined }),
      encoded({ ...valid, created_at: "not-a-date" }),
      encoded({ ...valid, created_at: "2026-08-25T12:00:00Z" }),
      encoded({ ...valid, id: "not-a-uuid" }),
      encoded({ ...valid, tenant_id: "forbidden" }),
      encoded({
        kind: "runs",
        version: 1,
        status_filter: "queued",
        created_at: valid.created_at,
        id: valid.id,
      }),
      serviceCursor,
    ];

    for (const cursor of invalid) {
      expect(() => decodeRunListCursor(cursor)).toThrow(TypeError);
    }
  });

  it("rejects invalid positions before encoding", () => {
    expect(() =>
      encodeRunListCursor({
        statusFilter: null,
        serviceIdFilter: "not-a-uuid",
        createdAt: "not-a-date",
        id: "not-a-uuid",
      }),
    ).toThrow(TypeError);
  });

  it("accepts a canonical legacy cursor as an unfiltered service page", () => {
    const legacy = Buffer.from(
      JSON.stringify({
        version: 1,
        kind: "runs",
        status_filter: "queued",
        created_at: "2026-08-25T12:00:00.000Z",
        id: "55555555-5555-4555-8555-555555555555",
      }),
      "utf8",
    ).toString("base64url");

    expect(decodeRunListCursor(legacy)).toEqual({
      statusFilter: "queued",
      serviceIdFilter: null,
      createdAt: "2026-08-25T12:00:00.000Z",
      id: "55555555-5555-4555-8555-555555555555",
    });
  });
});
