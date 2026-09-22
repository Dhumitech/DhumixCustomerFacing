import { ApplicationError } from "../../utils/applicationError.js";
import type { GetPlatformStatusRepository } from "./getPlatformStatusRepository.js";

export const PLATFORM_PRODUCT_FAMILIES = [
  "scraper_library",
  "marketplace_dataset",
] as const;
export type PlatformProductFamily = (typeof PLATFORM_PRODUCT_FAMILIES)[number];

export const PLATFORM_PRODUCT_STATES = [
  "operational",
  "degraded",
  "unavailable",
  "not_enabled",
  "unknown",
] as const;
export type PlatformProductState = (typeof PLATFORM_PRODUCT_STATES)[number];

export interface PlatformStatus {
  readonly state: "operational";
  readonly products: readonly {
    readonly family: PlatformProductFamily;
    readonly state: PlatformProductState;
    readonly message?: string | null;
    readonly updated_at: string;
  }[];
  readonly updated_at: string;
}

export interface GetPlatformStatusService {
  get(): Promise<PlatformStatus>;
}

function projectionUnavailable(cause?: unknown): ApplicationError {
  return new ApplicationError({
    status: 500,
    code: "INTERNAL_ERROR",
    title: "Internal server error",
    cause,
  });
}

function isProductState(value: string): value is PlatformProductState {
  return (PLATFORM_PRODUCT_STATES as readonly string[]).includes(value);
}

export function createGetPlatformStatusService(dependencies: {
  readonly repository: GetPlatformStatusRepository;
}): GetPlatformStatusService {
  return {
    async get(): Promise<PlatformStatus> {
      const records = await dependencies.repository.get();
      if (records.length !== PLATFORM_PRODUCT_FAMILIES.length) {
        throw projectionUnavailable();
      }

      const evaluatedAt = records[0]?.updatedAt;
      if (evaluatedAt === undefined || Number.isNaN(evaluatedAt.getTime())) {
        throw projectionUnavailable();
      }

      const updatedAt = evaluatedAt.toISOString();
      const products = records.map((record, index) => {
        if (
          record.family !== PLATFORM_PRODUCT_FAMILIES[index] ||
          !isProductState(record.state) ||
          Number.isNaN(record.updatedAt.getTime()) ||
          record.updatedAt.toISOString() !== updatedAt
        ) {
          throw projectionUnavailable();
        }
        return {
          family: record.family as PlatformProductFamily,
          state: record.state,
          ...(record.message == null ? {} : { message: record.message }),
          updated_at: updatedAt,
        };
      });

      return {
        state: "operational",
        products,
        updated_at: updatedAt,
      };
    },
  };
}
