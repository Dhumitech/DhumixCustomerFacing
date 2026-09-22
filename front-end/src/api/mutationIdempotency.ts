const STORAGE_PREFIX = "dhumi.mutation-idempotency.v1.";
const MAX_RETAINED_KEYS = 64;
const memoryKeys = new Map<string, string>();

interface StoredMutationKey {
  readonly key: string;
  readonly createdAt: number;
}

export interface MutationIdempotencyLease {
  readonly headerValue: string;
  readonly storageKey: string;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item ?? null)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? "null" : encoded;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function readStored(storageKey: string): string | null {
  try {
    const encoded = sessionStorage.getItem(storageKey);
    if (encoded === null) return memoryKeys.get(storageKey) ?? null;
    const value = JSON.parse(encoded) as Partial<StoredMutationKey>;
    return typeof value.key === "string" ? value.key : null;
  } catch {
    return memoryKeys.get(storageKey) ?? null;
  }
}

function pruneStorage(): void {
  try {
    const candidates: Array<
      StoredMutationKey & { readonly storageKey: string }
    > = [];
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const storageKey = sessionStorage.key(index);
      if (storageKey === null || !storageKey.startsWith(STORAGE_PREFIX))
        continue;
      try {
        const value = JSON.parse(
          sessionStorage.getItem(storageKey) ?? "null",
        ) as Partial<StoredMutationKey> | null;
        if (
          value !== null &&
          typeof value.key === "string" &&
          typeof value.createdAt === "number"
        ) {
          candidates.push({
            key: value.key,
            createdAt: value.createdAt,
            storageKey,
          });
        }
      } catch {
        sessionStorage.removeItem(storageKey);
      }
    }
    candidates
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(MAX_RETAINED_KEYS)
      .forEach((candidate) => {
        sessionStorage.removeItem(candidate.storageKey);
      });
  } catch {
    while (memoryKeys.size > MAX_RETAINED_KEYS) {
      const oldest = memoryKeys.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      memoryKeys.delete(oldest);
    }
  }
}

function writeStored(storageKey: string, key: string): void {
  memoryKeys.set(storageKey, key);
  try {
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({
        key,
        createdAt: Date.now(),
      } satisfies StoredMutationKey),
    );
    pruneStorage();
  } catch {
    pruneStorage();
  }
}

export async function acquireMutationIdempotency(
  action: string,
  canonicalRequest: unknown,
): Promise<MutationIdempotencyLease> {
  const fingerprint = await sha256(canonicalJson(canonicalRequest));
  const storageKey = `${STORAGE_PREFIX}${action}.${fingerprint}`;
  const existing = readStored(storageKey);
  if (existing !== null) return { headerValue: existing, storageKey };

  const headerValue = `frontend.${action}.${crypto.randomUUID()}`;
  writeStored(storageKey, headerValue);
  return { headerValue, storageKey };
}

export function completeMutationIdempotency(
  lease: MutationIdempotencyLease,
): void {
  memoryKeys.delete(lease.storageKey);
  try {
    const current = readStored(lease.storageKey);
    if (current === lease.headerValue)
      sessionStorage.removeItem(lease.storageKey);
  } catch {
    // The in-memory entry is already removed. A blocked storage API needs no
    // further cleanup and never changes request behavior.
  }
}
