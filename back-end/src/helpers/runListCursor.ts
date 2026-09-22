export const RUN_PUBLIC_STATUSES = [
  "queued",
  "running",
  "ready",
  "failed",
  "cancelled",
  "expired",
] as const;

export type RunPublicStatus = (typeof RUN_PUBLIC_STATUSES)[number];

export interface RunListCursorPosition {
  readonly statusFilter: RunPublicStatus | null;
  readonly serviceIdFilter?: string | null;
  readonly createdAt: string;
  readonly id: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const CURSOR_MAX_LENGTH = 2048;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

interface RunListCursorPayloadV1 {
  readonly version: 1;
  readonly kind: "runs";
  readonly status_filter: RunPublicStatus | null;
  readonly created_at: string;
  readonly id: string;
}

interface RunListCursorPayloadV2 {
  readonly version: 2;
  readonly kind: "runs";
  readonly status_filter: RunPublicStatus | null;
  readonly service_id_filter: string | null;
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

export function isRunPublicStatus(value: unknown): value is RunPublicStatus {
  return (
    typeof value === "string" &&
    (RUN_PUBLIC_STATUSES as readonly string[]).includes(value)
  );
}

function validPosition(position: RunListCursorPosition): boolean {
  return (
    (position.statusFilter === null || isRunPublicStatus(position.statusFilter)) &&
    (position.serviceIdFilter === undefined ||
      position.serviceIdFilter === null ||
      UUID_PATTERN.test(position.serviceIdFilter)) &&
    isCanonicalDateTime(position.createdAt) &&
    UUID_PATTERN.test(position.id)
  );
}

export function encodeRunListCursor(position: RunListCursorPosition): string {
  if (!validPosition(position)) {
    throw new TypeError("Run cursor position is invalid");
  }

  const payload: RunListCursorPayloadV2 = {
    version: 2,
    kind: "runs",
    status_filter: position.statusFilter,
    service_id_filter: position.serviceIdFilter ?? null,
    created_at: position.createdAt,
    id: position.id,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeRunListCursor(cursor: string): RunListCursorPosition {
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
    if (!isRecord(payload) || payload.kind !== "runs") {
      throw new Error("Cursor payload is invalid");
    }

    const legacy = payload.version === 1;
    if (
      (payload.version !== 1 && payload.version !== 2) ||
      !(
        payload.status_filter === null ||
        isRunPublicStatus(payload.status_filter)
      ) ||
      (!legacy &&
        !(
          payload.service_id_filter === null ||
          (typeof payload.service_id_filter === "string" &&
            UUID_PATTERN.test(payload.service_id_filter))
        )) ||
      !isCanonicalDateTime(payload.created_at) ||
      typeof payload.id !== "string" ||
      !UUID_PATTERN.test(payload.id) ||
      Object.keys(payload).join(",") !==
        (legacy
          ? "version,kind,status_filter,created_at,id"
          : "version,kind,status_filter,service_id_filter,created_at,id")
    ) {
      throw new Error("Cursor payload is invalid");
    }

    const position = Object.freeze({
      statusFilter: payload.status_filter,
      serviceIdFilter: legacy ? null : (payload.service_id_filter as string | null),
      createdAt: payload.created_at,
      id: payload.id,
    });
    const canonical = legacy
      ? Buffer.from(
          JSON.stringify({
            version: 1,
            kind: "runs",
            status_filter: position.statusFilter,
            created_at: position.createdAt,
            id: position.id,
          } satisfies RunListCursorPayloadV1),
          "utf8",
        ).toString("base64url")
      : encodeRunListCursor(position);
    if (canonical !== cursor) {
      throw new Error("Cursor payload is not canonical");
    }
    return position;
  } catch (cause) {
    throw new TypeError("Run list cursor is invalid", { cause });
  }
}
