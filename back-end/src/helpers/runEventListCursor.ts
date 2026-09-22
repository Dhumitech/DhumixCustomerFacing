export interface RunEventListCursorPosition {
  readonly runId: string;
  readonly sequence: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/;
const MAX_BIGINT = 9_223_372_036_854_775_807n;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const CURSOR_MAX_LENGTH = 2048;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

interface RunEventListCursorPayload {
  readonly version: 1;
  readonly kind: "run_events";
  readonly run_id: string;
  readonly sequence: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSequence(value: unknown): value is string {
  if (typeof value !== "string" || !POSITIVE_DECIMAL_PATTERN.test(value)) {
    return false;
  }

  try {
    return BigInt(value) <= MAX_BIGINT;
  } catch {
    return false;
  }
}

function validPosition(position: RunEventListCursorPosition): boolean {
  return UUID_PATTERN.test(position.runId) && isSequence(position.sequence);
}

export function encodeRunEventListCursor(
  position: RunEventListCursorPosition,
): string {
  if (!validPosition(position)) {
    throw new TypeError("Run event cursor position is invalid");
  }

  const payload: RunEventListCursorPayload = {
    version: 1,
    kind: "run_events",
    run_id: position.runId,
    sequence: position.sequence,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeRunEventListCursor(
  cursor: string,
): RunEventListCursorPosition {
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
      payload.kind !== "run_events" ||
      typeof payload.run_id !== "string" ||
      !UUID_PATTERN.test(payload.run_id) ||
      !isSequence(payload.sequence) ||
      Object.keys(payload).join(",") !== "version,kind,run_id,sequence"
    ) {
      throw new Error("Cursor payload is invalid");
    }

    const position = Object.freeze({
      runId: payload.run_id,
      sequence: payload.sequence,
    });
    if (encodeRunEventListCursor(position) !== cursor) {
      throw new Error("Cursor payload is not canonical");
    }
    return position;
  } catch (cause) {
    throw new TypeError("Run event list cursor is invalid", { cause });
  }
}
