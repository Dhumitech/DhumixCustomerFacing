import {
  decodeRunEventListCursor,
  encodeRunEventListCursor,
  type RunEventListCursorPosition,
} from "../../helpers/runEventListCursor.js";
import type { TrustedTenantPrincipal } from "../tenantAccess/trustedTenantPrincipal.js";
import type { ListRunEventsRecord, ListRunEventsRepository } from "./listRunEventsRepository.js";
import {
  runEventListValidationFailed,
  runEventProjectionUnavailable,
  runQueryNotFound,
} from "./runQueryErrors.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const LIMIT_PATTERN = /^(?:[1-9]|[1-9][0-9]|100)$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const RUN_EVENT_TYPES = [
  "accepted",
  "queued",
  "started",
  "progress",
  "result_received",
  "completed",
  "failed",
  "cancellation_requested",
  "cancelled",
  "expired",
] as const;

export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

interface EventProjection {
  readonly type: RunEventType;
  readonly message: string;
}

const EVENT_PROJECTIONS = new Map<string, EventProjection>([
  ["accepted", { type: "accepted", message: "Run accepted." }],
  ["queued", { type: "queued", message: "Run queued." }],
  ["started", { type: "started", message: "Run started." }],
  ["submitted", { type: "started", message: "Run started." }],
  ["provider.accepted", { type: "started", message: "Run started." }],
  ["progress", { type: "progress", message: "Run is in progress." }],
  ["processing", { type: "progress", message: "Run is in progress." }],
  ["reconciliation_scheduled", { type: "progress", message: "Run recovery is in progress." }],
  ["result_received", { type: "result_received", message: "Run result received." }],
  ["completed", { type: "completed", message: "Run completed." }],
  ["failed", { type: "failed", message: "Run failed." }],
  ["provider.failed", { type: "failed", message: "Run failed." }],
  [
    "cancellation_requested",
    { type: "cancellation_requested", message: "Cancellation requested." },
  ],
  ["cancelled", { type: "cancelled", message: "Run cancelled." }],
  ["expired", { type: "expired", message: "Run expired." }],
]);

export interface RunEvent {
  readonly id: string;
  readonly type: RunEventType;
  readonly message: string;
  readonly occurred_at: string;
}

export interface RunEventPage {
  readonly data: readonly RunEvent[];
  readonly page: {
    readonly next_cursor: string | null;
    readonly has_more: boolean;
  };
}

export interface ListRunEventsRequest {
  readonly principal: TrustedTenantPrincipal;
  readonly runId: unknown;
  readonly cursor: unknown;
  readonly limit: unknown;
  readonly schemaErrors: readonly {
    readonly field: string;
    readonly message: string;
  }[];
}

export interface ListRunEventsService {
  list(request: ListRunEventsRequest): Promise<RunEventPage>;
}

export interface ListRunEventsServiceDependencies {
  readonly repository: ListRunEventsRepository;
}

function validationError(field: string, message: string): never {
  throw runEventListValidationFailed([{ field, message }]);
}

function hasPathSchemaError(errors: ListRunEventsRequest["schemaErrors"]): boolean {
  return errors.some(
    (error) => error.field === "params" || error.field === "run_id" || error.field === "/run_id",
  );
}

function parseRunId(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw runQueryNotFound();
  }
  return value.toLowerCase();
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

function parseCursor(value: unknown, runId: string): RunEventListCursorPosition | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    return validationError("cursor", "must be a valid Run event page cursor");
  }

  try {
    const cursor = decodeRunEventListCursor(value);
    if (cursor.runId !== runId) {
      return validationError("cursor", "must belong to the addressed Run event page");
    }
    return cursor;
  } catch {
    return validationError("cursor", "must be a valid Run event page cursor");
  }
}

function publicEvent(record: ListRunEventsRecord): RunEvent {
  const projection = EVENT_PROJECTIONS.get(record.eventType);
  if (projection === undefined) throw runEventProjectionUnavailable();

  return {
    id: record.id,
    type: projection.type,
    message: projection.message,
    occurred_at: record.occurredAt.toISOString(),
  };
}

export function createListRunEventsService(
  dependencies: ListRunEventsServiceDependencies,
): ListRunEventsService {
  return {
    async list(request): Promise<RunEventPage> {
      if (hasPathSchemaError(request.schemaErrors)) {
        throw runQueryNotFound();
      }
      if (request.schemaErrors.length > 0) {
        throw runEventListValidationFailed(request.schemaErrors);
      }

      const runId = parseRunId(request.runId);
      const limit = parseLimit(request.limit);
      const cursor = parseCursor(request.cursor, runId);
      const records = await dependencies.repository.findPage({
        tenantId: request.principal.tenantId,
        userId: request.principal.userId,
        runId,
        afterSequence: cursor?.sequence,
        fetchLimit: limit + 1,
      });
      if (records === undefined) throw runQueryNotFound();

      const hasMore = records.length > limit;
      const visibleRecords = records.slice(0, limit);
      const lastVisible = visibleRecords.at(-1);

      return {
        data: visibleRecords.map(publicEvent),
        page: {
          next_cursor:
            hasMore && lastVisible !== undefined
              ? encodeRunEventListCursor({
                  runId,
                  sequence: lastVisible.sequence,
                })
              : null,
          has_more: hasMore,
        },
      };
    },
  };
}
