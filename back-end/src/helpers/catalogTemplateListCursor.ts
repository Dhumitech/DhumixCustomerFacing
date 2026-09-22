export const CATALOG_PRODUCT_FAMILIES = [
  "marketplace_dataset",
  "scraper_library",
] as const;

export type CatalogProductFamily = (typeof CATALOG_PRODUCT_FAMILIES)[number];

export interface CatalogTemplateListCursorPosition {
  readonly familyFilter: CatalogProductFamily | null;
  readonly family: CatalogProductFamily;
  readonly slug: string;
  readonly id: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,98}[a-z0-9]$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const CURSOR_MAX_LENGTH = 2048;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

interface CatalogTemplateListCursorPayload {
  readonly version: 1;
  readonly kind: "catalog_templates";
  readonly family_filter: CatalogProductFamily | null;
  readonly family: CatalogProductFamily;
  readonly slug: string;
  readonly id: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProductFamily(value: unknown): value is CatalogProductFamily {
  return (
    typeof value === "string" &&
    CATALOG_PRODUCT_FAMILIES.some((family) => family === value)
  );
}

function isFamilyFilter(value: unknown): value is CatalogProductFamily | null {
  return value === null || isProductFamily(value);
}

function validPosition(position: CatalogTemplateListCursorPosition): boolean {
  return (
    isFamilyFilter(position.familyFilter) &&
    isProductFamily(position.family) &&
    (position.familyFilter === null || position.family === position.familyFilter) &&
    SLUG_PATTERN.test(position.slug) &&
    UUID_PATTERN.test(position.id)
  );
}

export function encodeCatalogTemplateListCursor(
  position: CatalogTemplateListCursorPosition,
): string {
  if (!validPosition(position)) {
    throw new TypeError("Catalogue Template cursor position is invalid");
  }
  const payload: CatalogTemplateListCursorPayload = {
    version: 1,
    kind: "catalog_templates",
    family_filter: position.familyFilter,
    family: position.family,
    slug: position.slug,
    id: position.id,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeCatalogTemplateListCursor(
  cursor: string,
): CatalogTemplateListCursorPosition {
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
      payload.kind !== "catalog_templates" ||
      !isFamilyFilter(payload.family_filter) ||
      !isProductFamily(payload.family) ||
      typeof payload.slug !== "string" ||
      !SLUG_PATTERN.test(payload.slug) ||
      typeof payload.id !== "string" ||
      !UUID_PATTERN.test(payload.id) ||
      Object.keys(payload).join(",") !==
        "version,kind,family_filter,family,slug,id"
    ) {
      throw new Error("Cursor payload is invalid");
    }
    const position = Object.freeze({
      familyFilter: payload.family_filter,
      family: payload.family,
      slug: payload.slug,
      id: payload.id,
    });
    if (encodeCatalogTemplateListCursor(position) !== cursor) {
      throw new Error("Cursor payload is not canonical");
    }
    return position;
  } catch (cause) {
    throw new TypeError("Catalogue Template list cursor is invalid", { cause });
  }
}
