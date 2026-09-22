import { createHash } from "node:crypto";

/** Stable JSON used only for hashes and immutable schema identities. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`);
    return `{${entries.join(",")}}`;
  }

  return JSON.stringify(value) ?? "null";
}

export function canonicalSha256(value: unknown): Buffer {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest();
}
