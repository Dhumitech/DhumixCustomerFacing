import {
  decodeUsageEventListCursor,
  encodeUsageEventListCursor,
  type UsageEventListCursorPosition,
} from "../../helpers/usageEventListCursor.js";
import type { TrustedTenantPrincipal } from "../tenantAccess/trustedTenantPrincipal.js";
import type {
  ListUsageEventsRecord,
  ListUsageEventsRepository,
} from "./listUsageEventsRepository.js";
import {
  usageProjectionUnavailable,
  usageReadValidationFailed,
} from "./usageReadErrors.js";
import { parseUsageTimeRange } from "./usageTimeRange.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const LIMIT_PATTERN = /^(?:[1-9]|[1-9][0-9]|100)$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const USAGE_PRODUCT_FAMILIES = [
  "marketplace_dataset",
  "scraper_library",
] as const;
export type UsageProductFamily = (typeof USAGE_PRODUCT_FAMILIES)[number];

export const USAGE_OUTCOMES = [
  "accepted",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type UsageOutcome = (typeof USAGE_OUTCOMES)[number];

export interface UsageEvent {
  readonly id: string;
  readonly run_id: string;
  readonly product_family: UsageProductFamily;
  readonly meter: string;
  readonly quantity: number;
  readonly unit: string;
  readonly outcome: UsageOutcome;
  readonly observed_at: string;
}

export interface UsageEventPage {
  readonly data: readonly UsageEvent[];
  readonly page: {
    readonly next_cursor: string | null;
    readonly has_more: boolean;
  };
}

export interface ListUsageEventsRequest {
  readonly principal: TrustedTenantPrincipal;
  readonly from: unknown;
  readonly to: unknown;
  readonly cursor: unknown;
  readonly limit: unknown;
  readonly schemaErrors: readonly {
    readonly field: string;
    readonly message: string;
  }[];
}

export interface ListUsageEventsService {
  list(request: ListUsageEventsRequest): Promise<UsageEventPage>;
}

function validationError(field: string, message: string): never {
  throw usageReadValidationFailed([{ field, message }]);
}

function parseLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (typeof value !== "string" || !LIMIT_PATTERN.test(value)) {
    return validationError("limit", "must be an integer between 1 and 100");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
    return validationError("limit", "must be an integer between 1 and 100");
  }
  return parsed;
}

function parseCursor(
  value: unknown,
  from: string,
  to: string,
): UsageEventListCursorPosition | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    return validationError("cursor", "must be a valid usage event page cursor");
  }

  try {
    const cursor = decodeUsageEventListCursor(value);
    if (cursor.from !== from || cursor.to !== to) {
      return validationError(
        "cursor",
        "must belong to the requested usage time window",
      );
    }
    return cursor;
  } catch {
    return validationError("cursor", "must be a valid usage event page cursor");
  }
}

function isProductFamily(value: string): value is UsageProductFamily {
  return (USAGE_PRODUCT_FAMILIES as readonly string[]).includes(value);
}

function isOutcome(value: string): value is UsageOutcome {
  return (USAGE_OUTCOMES as readonly string[]).includes(value);
}

function publicEvent(record: ListUsageEventsRecord): UsageEvent {
  const quantity = Number(record.quantity);
  if (
    !UUID_PATTERN.test(record.id) ||
    !UUID_PATTERN.test(record.runId) ||
    !isProductFamily(record.productFamily) ||
    !isOutcome(record.outcome) ||
    !Number.isFinite(quantity) ||
    quantity < 0 ||
    Number.isNaN(record.observedAt.getTime())
  ) {
    throw usageProjectionUnavailable();
  }

  return {
    id: record.id.toLowerCase(),
    run_id: record.runId.toLowerCase(),
    product_family: record.productFamily,
    meter: record.meter,
    quantity,
    unit: record.unit,
    outcome: record.outcome,
    observed_at: record.observedAt.toISOString(),
  };
}

export function createListUsageEventsService(dependencies: {
  readonly repository: ListUsageEventsRepository;
}): ListUsageEventsService {
  return {
    async list(request): Promise<UsageEventPage> {
      if (request.schemaErrors.length > 0) {
        throw usageReadValidationFailed(request.schemaErrors);
      }

      const range = parseUsageTimeRange(request.from, request.to);
      const limit = parseLimit(request.limit);
      const cursor = parseCursor(request.cursor, range.from, range.to);
      const records = await dependencies.repository.findPage({
        tenantId: request.principal.tenantId,
        from: range.from,
        to: range.to,
        beforeObservedAt: cursor?.observedAt,
        beforeId: cursor?.id,
        fetchLimit: limit + 1,
      });

      const hasMore = records.length > limit;
      const visibleRecords = records.slice(0, limit);
      const data = visibleRecords.map(publicEvent);
      const lastVisible = data.at(-1);
      const lastVisibleRecord = visibleRecords.at(-1);

      return {
        data,
        page: {
          next_cursor:
            hasMore && lastVisible !== undefined && lastVisibleRecord !== undefined
              ? encodeUsageEventListCursor({
                  from: range.from,
                  to: range.to,
                  observedAt: lastVisibleRecord.cursorObservedAt,
                  id: lastVisible.id,
                })
              : null,
          has_more: hasMore,
        },
      };
    },
  };
}
