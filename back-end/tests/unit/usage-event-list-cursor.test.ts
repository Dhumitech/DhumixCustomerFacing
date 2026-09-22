import { describe, expect, it } from "vitest";
import {
  decodeUsageEventListCursor,
  encodeUsageEventListCursor,
} from "../../src/helpers/usageEventListCursor.js";

const position = {
  from: "2026-08-01T00:00:00.000Z",
  to: "2026-09-01T00:00:00.000Z",
  observedAt: "2026-08-30T08:57:06.000Z",
  id: "79000000-0000-4000-8000-000000000001",
} as const;

describe("usage event list cursor", () => {
  it("round-trips the exact time window and keyset position", () => {
    expect(decodeUsageEventListCursor(encodeUsageEventListCursor(position))).toEqual(
      position,
    );
  });

  it("rejects non-canonical, malformed and unknown-field payloads", () => {
    const encoded = (value: unknown) =>
      Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    const cases = [
      "not+base64url",
      encoded({ ...position }),
      encoded({
        version: 1,
        kind: "usage_events",
        from: position.from,
        to: position.to,
        observed_at: position.observedAt,
        id: position.id,
        provider_id: "forbidden",
      }),
      encoded({
        version: 1,
        kind: "usage_events",
        from: "2026-08-01T00:00:00Z",
        to: position.to,
        observed_at: position.observedAt,
        id: position.id,
      }),
      encoded({
        version: 1,
        kind: "usage_events",
        from: position.from,
        to: position.to,
        observed_at: "2026-02-31T00:00:00.000Z",
        id: position.id,
      }),
    ];

    for (const cursor of cases) {
      expect(() => decodeUsageEventListCursor(cursor)).toThrow(TypeError);
    }
  });
});
