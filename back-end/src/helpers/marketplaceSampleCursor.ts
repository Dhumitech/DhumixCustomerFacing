import { createHmac, timingSafeEqual } from "node:crypto";

const CURSOR_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const CONTEXT_PATTERN = /^[0-9a-f]{64}$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface MarketplaceSampleCursorPosition {
  readonly templateSlug: string;
  readonly templateVersion: number;
  readonly sampleVersion: number;
  readonly contextHash: string;
  readonly offset: number;
}

interface CursorPayload {
  readonly v: 1;
  readonly k: "marketplace_sample";
  readonly s: string;
  readonly tv: number;
  readonly sv: number;
  readonly q: string;
  readonly o: number;
}

function valid(position: MarketplaceSampleCursorPosition): boolean {
  return SLUG_PATTERN.test(position.templateSlug) &&
    Number.isSafeInteger(position.templateVersion) && position.templateVersion > 0 &&
    Number.isSafeInteger(position.sampleVersion) && position.sampleVersion > 0 &&
    CONTEXT_PATTERN.test(position.contextHash) &&
    Number.isSafeInteger(position.offset) && position.offset > 0;
}

function signature(secret: string, encodedPayload: string): Buffer {
  return createHmac("sha256", secret)
    .update(`dhumi:marketplace-sample-cursor:v1:${encodedPayload}`, "utf8")
    .digest();
}

export function encodeMarketplaceSampleCursor(
  position: MarketplaceSampleCursorPosition,
  secret: string,
): string {
  if (!valid(position) || secret.length < 32) {
    throw new TypeError("Marketplace sample cursor input is invalid");
  }
  const payload: CursorPayload = {
    v: 1,
    k: "marketplace_sample",
    s: position.templateSlug,
    tv: position.templateVersion,
    sv: position.sampleVersion,
    q: position.contextHash,
    o: position.offset,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${signature(secret, encoded).toString("base64url")}`;
}

export function decodeMarketplaceSampleCursor(
  cursor: string,
  secret: string,
): MarketplaceSampleCursorPosition {
  try {
    if (cursor.length > 2048 || !CURSOR_PATTERN.test(cursor) || secret.length < 32) {
      throw new Error("Cursor format is invalid");
    }
    const [encoded, presentedSignature] = cursor.split(".");
    if (encoded === undefined || presentedSignature === undefined) {
      throw new Error("Cursor format is invalid");
    }
    const expected = signature(secret, encoded);
    const presented = Buffer.from(presentedSignature, "base64url");
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      throw new Error("Cursor signature is invalid");
    }
    const payload: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      throw new Error("Cursor payload is invalid");
    }
    const value = payload as Record<string, unknown>;
    if (
      value.v !== 1 || value.k !== "marketplace_sample" ||
      typeof value.s !== "string" || typeof value.tv !== "number" ||
      typeof value.sv !== "number" || typeof value.q !== "string" ||
      typeof value.o !== "number" ||
      Object.keys(value).join(",") !== "v,k,s,tv,sv,q,o"
    ) {
      throw new Error("Cursor payload is invalid");
    }
    const position = {
      templateSlug: value.s,
      templateVersion: value.tv,
      sampleVersion: value.sv,
      contextHash: value.q,
      offset: value.o,
    };
    if (!valid(position)) throw new Error("Cursor position is invalid");
    return Object.freeze(position);
  } catch (cause) {
    throw new TypeError("Marketplace sample cursor is invalid", { cause });
  }
}
