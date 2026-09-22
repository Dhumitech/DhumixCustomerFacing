import { dhumiClient } from "./client";
import { asDhumiRequest } from "./errors";
import {
  getPlatformStatus as generatedGetPlatformStatus,
  type PlatformStatus,
} from "./generated";

const PLATFORM_STATES = new Set([
  "operational",
  "degraded",
  "unavailable",
  "maintenance",
  "unknown",
]);
const PRODUCT_STATES = new Set([
  "operational",
  "degraded",
  "unavailable",
  "not_enabled",
  "unknown",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPlatformStatus(value: unknown): value is PlatformStatus {
  if (
    !isRecord(value) ||
    typeof value.state !== "string" ||
    !PLATFORM_STATES.has(value.state) ||
    typeof value.updated_at !== "string" ||
    !Array.isArray(value.products)
  ) {
    return false;
  }

  return value.products.every(
    (product) =>
      isRecord(product) &&
      typeof product.family === "string" &&
      typeof product.state === "string" &&
      PRODUCT_STATES.has(product.state) &&
      typeof product.updated_at === "string" &&
      (product.message === undefined ||
        product.message === null ||
        typeof product.message === "string"),
  );
}

export const platformStatusApi = Object.freeze({
  async get(): Promise<PlatformStatus> {
    const response = await asDhumiRequest(
      generatedGetPlatformStatus({
        client: dhumiClient,
        throwOnError: true,
      }),
    );

    if (!isPlatformStatus(response.data)) {
      throw new Error("Dhumi returned an invalid platform-status response.");
    }

    return response.data;
  },
});
