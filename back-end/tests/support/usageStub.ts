import type { GetUsageSummaryService } from "../../src/services/usage/getUsageSummaryService.js";
import type { ListUsageEventsService } from "../../src/services/usage/listUsageEventsService.js";

function unexpected(operation: string): never {
  throw new Error(`Unexpected ${operation} call in this test`);
}

export const stubGetUsageSummaryService: GetUsageSummaryService = {
  async get() {
    return unexpected("getUsageSummaryService.get");
  },
};

export const stubListUsageEventsService: ListUsageEventsService = {
  async list() {
    return unexpected("listUsageEventsService.list");
  },
};
