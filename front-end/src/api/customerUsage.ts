import { organizationHeaders } from "./organizationScope";
import { dhumiClient } from "./client";
import { asDhumiRequest } from "./errors";
import {
  getUsageSummary as generatedGetUsageSummary,
  listUsageEvents as generatedListUsageEvents,
  type UsageEventPage,
  type UsageSummary,
} from "./generated";

const MAX_PAGE_SIZE = 100;

export interface UsageTimeRange {
  readonly from: string;
  readonly to: string;
}

export interface UsageEventRequest extends UsageTimeRange {
  readonly cursor?: string;
}

export const usageApi = Object.freeze({
  async summary(range: UsageTimeRange): Promise<UsageSummary> {
    const scope = organizationHeaders();
    const response = await asDhumiRequest(
      generatedGetUsageSummary({
        client: dhumiClient, headers: scope,
        query: range,
        throwOnError: true,
      }),
    );
    return response.data;
  },

  async events(request: UsageEventRequest): Promise<UsageEventPage> {
    const scope = organizationHeaders();
    const response = await asDhumiRequest(
      generatedListUsageEvents({
        client: dhumiClient, headers: scope,
        query: {
          from: request.from,
          to: request.to,
          limit: MAX_PAGE_SIZE,
          ...(request.cursor ? { cursor: request.cursor } : {}),
        },
        throwOnError: true,
      }),
    );
    return response.data;
  },
});
