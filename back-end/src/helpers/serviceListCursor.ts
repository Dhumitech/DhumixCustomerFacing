export interface ServiceListCursorPosition {
  readonly createdAt: string;
  readonly id: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const CURSOR_MAX_LENGTH = 2048;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

interface ServiceListCursorPayload {
  readonly version: 1;
  readonly kind: "services";
  readonly created_at: string;
  readonly id: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCanonicalDateTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function validPosition(position: ServiceListCursorPosition): boolean {
  return isCanonicalDateTime(position.createdAt) && UUID_PATTERN.test(position.id);
}

export function encodeServiceListCursor(position: ServiceListCursorPosition): string {
  if (!validPosition(position)) {
    throw new TypeError("Service cursor position is invalid");
  }
  const payload: ServiceListCursorPayload = {
    version: 1,
    kind: "services",
    created_at: position.createdAt,
    id: position.id,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeServiceListCursor(cursor: string): ServiceListCursorPosition {
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
      payload.kind !== "services" ||
      !isCanonicalDateTime(payload.created_at) ||
      typeof payload.id !== "string" ||
      !UUID_PATTERN.test(payload.id) ||
      Object.keys(payload).join(",") !== "version,kind,created_at,id"
    ) {
      throw new Error("Cursor payload is invalid");
    }
    const position = Object.freeze({ createdAt: payload.created_at, id: payload.id });
    if (encodeServiceListCursor(position) !== cursor) {
      throw new Error("Cursor payload is not canonical");
    }
    return position;
  } catch (cause) {
    throw new TypeError("Service list cursor is invalid", { cause });
  }
}
