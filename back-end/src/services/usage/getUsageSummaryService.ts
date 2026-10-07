import type { TrustedTenantPrincipal } from "../tenantAccess/trustedTenantPrincipal.js";
import type { GetUsageSummaryRepository } from "./getUsageSummaryRepository.js";
import { usageProjectionUnavailable, usageReadValidationFailed } from "./usageReadErrors.js";
import { parseUsageTimeRange } from "./usageTimeRange.js";

export const USAGE_RECONCILIATION_STATES = [
  "observed",
  "partially_reconciled",
  "reconciled",
] as const;
export type UsageReconciliationState = (typeof USAGE_RECONCILIATION_STATES)[number];

export interface UsageSummary {
  readonly from: string;
  readonly to: string;
  readonly items: readonly {
    readonly meter: string;
    readonly quantity: number;
    readonly unit: string;
  }[];
  readonly updated_at: string;
  readonly state: UsageReconciliationState;
}

export interface GetUsageSummaryRequest {
  readonly principal: TrustedTenantPrincipal;
  readonly from: unknown;
  readonly to: unknown;
  readonly schemaErrors: readonly {
    readonly field: string;
    readonly message: string;
  }[];
}

export interface GetUsageSummaryService {
  get(request: GetUsageSummaryRequest): Promise<UsageSummary>;
}

function isState(value: string): value is UsageReconciliationState {
  return (USAGE_RECONCILIATION_STATES as readonly string[]).includes(value);
}

function publicQuantity(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw usageProjectionUnavailable();
  }
  return parsed;
}

export function createGetUsageSummaryService(dependencies: {
  readonly repository: GetUsageSummaryRepository;
}): GetUsageSummaryService {
  return {
    async get(request): Promise<UsageSummary> {
      if (request.schemaErrors.length > 0) {
        throw usageReadValidationFailed(request.schemaErrors);
      }
      const range = parseUsageTimeRange(request.from, request.to);
      const record = await dependencies.repository.get({
        tenantId: request.principal.tenantId,
        userId: request.principal.userId,
        from: range.from,
        to: range.to,
      });

      if (!isState(record.state) || Number.isNaN(record.updatedAt.getTime())) {
        throw usageProjectionUnavailable();
      }

      return {
        from: range.from,
        to: range.to,
        items: record.items.map((item) => ({
          meter: item.meter,
          quantity: publicQuantity(item.quantity),
          unit: item.unit,
        })),
        updated_at: record.updatedAt.toISOString(),
        state: record.state,
      };
    },
  };
}
