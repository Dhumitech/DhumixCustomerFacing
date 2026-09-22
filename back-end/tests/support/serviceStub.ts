import type { ListServicesService } from "../../src/services/customerServices/listServicesService.js";
import type { CreateServiceService } from "../../src/services/customerServices/createServiceService.js";
import type { GetServiceService } from "../../src/services/customerServices/getServiceService.js";
import type { CreateRunService } from "../../src/services/admission/createRunService.js";
import type { ListRunsService } from "../../src/services/runQuery/listRunsService.js";
import type { GetRunService } from "../../src/services/runQuery/getRunService.js";
import type { ListRunEventsService } from "../../src/services/runQuery/listRunEventsService.js";
import type { CancelRunService } from "../../src/services/admission/cancelRunService.js";
import type { RetryRunService } from "../../src/services/admission/retryRunService.js";
import type { GetRunResultService } from "../../src/services/runQuery/getRunResultService.js";

function unexpected(operation: string): never {
  throw new Error(`Unexpected ${operation} call in this test`);
}

export const stubListServicesService: ListServicesService = {
  async list() {
    return unexpected("listServicesService.list");
  },
};

export const stubCreateServiceService: CreateServiceService = {
  async create() {
    return unexpected("createServiceService.create");
  },
};

export const stubGetServiceService: GetServiceService = {
  async get() {
    return unexpected("getServiceService.get");
  },
};

export const stubCreateRunService: CreateRunService = {
  async create() {
    return unexpected("createRunService.create");
  },
};

export const stubListRunsService: ListRunsService = {
  async list() {
    return unexpected("listRunsService.list");
  },
};

export const stubGetRunService: GetRunService = {
  async get() {
    return unexpected("getRunService.get");
  },
};

export const stubListRunEventsService: ListRunEventsService = {
  async list() {
    return unexpected("listRunEventsService.list");
  },
};

export const stubCancelRunService: CancelRunService = {
  async cancel() {
    return unexpected("cancelRunService.cancel");
  },
};

export const stubRetryRunService: RetryRunService = {
  async retry() {
    return unexpected("retryRunService.retry");
  },
};

export const stubGetRunResultService: GetRunResultService = {
  async get() {
    return unexpected("getRunResultService.get");
  },
};
