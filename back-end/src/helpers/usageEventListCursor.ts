export interface UsageEventListCursorPosition {
  readonly from: string;
  readonly to: string;
  readonly observedAt: string;
  readonly id: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,9}Z$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const CURSOR_MAX_LENGTH = 2048;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

interface UsageEventListCursorPayload {
  readonly version: 1;
  readonly kind: "usage_events";
  readonly from: string;
  readonly to: string;
  readonly observed_at: string;
  readonly id: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCanonicalInstant(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_INSTANT_PATTERN.test(value)) return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;

  // Date normalizes impossible calendar values (for example February 31).
  // Compare its millisecond projection with the supplied calendar fields so
  // a malformed cursor fails before PostgreSQL receives it. Digits beyond
  // milliseconds remain valid because PostgreSQL cursor precision is retained
  // separately in the original string.
  return parsed.toISOString() === `${value.slice(0, 23)}Z`;
}

function validPosition(position: UsageEventListCursorPosition): boolean {
  return (
    isCanonicalInstant(position.from) &&
    isCanonicalInstant(position.to) &&
    isCanonicalInstant(position.observedAt) &&
    UUID_PATTERN.test(position.id)
  );
}

export function encodeUsageEventListCursor(
  position: UsageEventListCursorPosition,
): string {
  if (!validPosition(position)) {
    throw new TypeError("Usage event cursor position is invalid");
  }

  const payload: UsageEventListCursorPayload = {
    version: 1,
    kind: "usage_events",
    from: position.from,
    to: position.to,
    observed_at: position.observedAt,
    id: position.id,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeUsageEventListCursor(
  cursor: string,
): UsageEventListCursorPosition {
  try {
    if (
      cursor.length === 0 ||
      cursor.length > CURSOR_MAX_LENGTH ||
      !BASE64URL_PATTERN.test(cursor)
    ) {
      throw new Error("Cursor encoding is invalid");
    }

    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) {
      throw new Error("Cursor encoding is not canonical");
    }

    const payload: unknown = JSON.parse(utf8Decoder.decode(bytes));
    if (
      !isRecord(payload) ||
      payload.version !== 1 ||
      payload.kind !== "usage_events" ||
      !isCanonicalInstant(payload.from) ||
      !isCanonicalInstant(payload.to) ||
      !isCanonicalInstant(payload.observed_at) ||
      typeof payload.id !== "string" ||
      !UUID_PATTERN.test(payload.id) ||
      Object.keys(payload).join(",") !==
        "version,kind,from,to,observed_at,id"
    ) {
      throw new Error("Cursor payload is invalid");
    }

    const position = Object.freeze({
      from: payload.from,
      to: payload.to,
      observedAt: payload.observed_at,
      id: payload.id,
    });
    if (encodeUsageEventListCursor(position) !== cursor) {
      throw new Error("Cursor payload is not canonical");
    }
    return position;
  } catch (cause) {
    throw new TypeError("Usage event list cursor is invalid", { cause });
  }
}
