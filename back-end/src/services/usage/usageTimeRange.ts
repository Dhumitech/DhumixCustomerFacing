import { usageReadValidationFailed } from "./usageReadErrors.js";

const RFC3339_PATTERN =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

export interface UsageTimeRange {
  readonly from: string;
  readonly to: string;
}

interface ParsedDateTime {
  readonly canonical: string;
  readonly epochMicroseconds: bigint;
}

function parseDateTime(
  value: unknown,
  field: "from" | "to",
): ParsedDateTime {
  if (typeof value !== "string") {
    throw usageReadValidationFailed([
      { field, message: "must be an RFC 3339 date-time" },
    ]);
  }
  const match = RFC3339_PATTERN.exec(value);
  if (match === null) {
    throw usageReadValidationFailed([
      { field, message: "must be an RFC 3339 date-time" },
    ]);
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw usageReadValidationFailed([
      { field, message: "must be an RFC 3339 date-time" },
    ]);
  }

  const fraction = match[2] ?? "";
  const lowerMicroseconds = BigInt(
    fraction.slice(3, 6).padEnd(3, "0") || "0",
  );
  const roundUp = (fraction[6] ?? "0") >= "5" ? 1n : 0n;
  const epochMicroseconds =
    BigInt(parsed.getTime()) * 1_000n + lowerMicroseconds + roundUp;

  let wholeSeconds = epochMicroseconds / 1_000_000n;
  let microsecondsOfSecond = epochMicroseconds % 1_000_000n;
  if (microsecondsOfSecond < 0n) {
    wholeSeconds -= 1n;
    microsecondsOfSecond += 1_000_000n;
  }
  const utcSecond = new Date(Number(wholeSeconds * 1_000n));
  if (Number.isNaN(utcSecond.getTime())) {
    throw usageReadValidationFailed([
      { field, message: "must be an RFC 3339 date-time" },
    ]);
  }

  let normalizedFraction = microsecondsOfSecond.toString().padStart(6, "0");
  while (normalizedFraction.length > 3 && normalizedFraction.endsWith("0")) {
    normalizedFraction = normalizedFraction.slice(0, -1);
  }
  return {
    canonical: `${utcSecond.toISOString().slice(0, 19)}.${normalizedFraction}Z`,
    epochMicroseconds,
  };
}

export function parseUsageTimeRange(from: unknown, to: unknown): UsageTimeRange {
  const parsedFrom = parseDateTime(from, "from");
  const parsedTo = parseDateTime(to, "to");
  if (parsedFrom.epochMicroseconds >= parsedTo.epochMicroseconds) {
    throw usageReadValidationFailed([
      { field: "to", message: "must be later than from" },
    ]);
  }

  return Object.freeze({
    from: parsedFrom.canonical,
    to: parsedTo.canonical,
  });
}
