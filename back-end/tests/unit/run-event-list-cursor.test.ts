import { describe, expect, it } from "vitest";
import {
  decodeRunEventListCursor,
  encodeRunEventListCursor,
} from "../../src/helpers/runEventListCursor.js";
import { encodeRunListCursor } from "../../src/helpers/runListCursor.js";

const RUN_ID = "abcdef12-abcd-4abc-8abc-abcdef123456";

describe("Run event list cursor", () => {
  it("round-trips a canonical Run-bound bigint position", () => {
    const position = {
      runId: RUN_ID,
      sequence: "9007199254740993",
    } as const;

    const cursor = encodeRunEventListCursor(position);

    expect(cursor).toBe(
      Buffer.from(
        JSON.stringify({
          version: 1,
          kind: "run_events",
          run_id: RUN_ID,
          sequence: "9007199254740993",
        }),
        "utf8",
      ).toString("base64url"),
    );
    expect(decodeRunEventListCursor(cursor)).toEqual(position);
  });

  it("accepts the maximum PostgreSQL bigint sequence without Number conversion", () => {
    const position = {
      runId: RUN_ID,
      sequence: "9223372036854775807",
    } as const;

    expect(
      decodeRunEventListCursor(encodeRunEventListCursor(position)),
    ).toEqual(position);
  });

  it("rejects malformed, non-canonical, oversized, and operation-mismatched cursors", () => {
    const encoded = (value: unknown) =>
      Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    const runCursor = encodeRunListCursor({
      statusFilter: null,
      createdAt: "2026-08-25T12:00:00.000Z",
      id: RUN_ID,
    });
    const valid = {
      version: 1,
      kind: "run_events",
      run_id: RUN_ID,
      sequence: "42",
    } as const;
    const invalid = [
      "",
      "a".repeat(2049),
      "not+base64url",
      `${encoded(valid)}=`,
      Buffer.from([0xff]).toString("base64url"),
      encoded(null),
      encoded({ ...valid, version: 2 }),
      encoded({ ...valid, kind: "runs" }),
      encoded({ ...valid, run_id: RUN_ID.toUpperCase() }),
      encoded({ ...valid, run_id: "not-a-uuid" }),
      encoded({ ...valid, sequence: 42 }),
      encoded({ ...valid, sequence: "0" }),
      encoded({ ...valid, sequence: "-1" }),
      encoded({ ...valid, sequence: "01" }),
      encoded({ ...valid, sequence: "1.5" }),
      encoded({ ...valid, sequence: "1e3" }),
      encoded({ ...valid, sequence: "9223372036854775808" }),
      encoded({ ...valid, tenant_id: "forbidden" }),
      encoded({
        kind: "run_events",
        version: 1,
        run_id: RUN_ID,
        sequence: "42",
      }),
      runCursor,
    ];

    for (const cursor of invalid) {
      expect(() => decodeRunEventListCursor(cursor)).toThrow(TypeError);
    }
  });

  it("rejects invalid positions before encoding", () => {
    const invalid = [
      { runId: RUN_ID.toUpperCase(), sequence: "1" },
      { runId: "not-a-uuid", sequence: "1" },
      { runId: RUN_ID, sequence: "0" },
      { runId: RUN_ID, sequence: "9223372036854775808" },
    ];

    for (const position of invalid) {
      expect(() => encodeRunEventListCursor(position)).toThrow(TypeError);
    }
  });
});
