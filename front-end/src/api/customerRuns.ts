import { dhumiClient } from "./client";
import { asDhumiRequest } from "./errors";
import {
  type GetRunResultData,
  cancelRun as generatedCancelRun,
  createRun as generatedCreateRun,
  createService as generatedCreateService,
  getRun as generatedGetRun,
  getRunResult as generatedGetRunResult,
  getService as generatedGetService,
  listRunEvents as generatedListRunEvents,
  listRuns as generatedListRuns,
  retryRun as generatedRetryRun,
  type Run,
  type RunAccepted,
  type RunEventPage,
  type RunPage,
  type RunResult,
  type RunStatus,
  type Service,
} from "./generated";
import {
  acquireMutationIdempotency,
  completeMutationIdempotency,
} from "./mutationIdempotency";

const MAX_PAGE_SIZE = 100;

type GetRunResultQuery = NonNullable<GetRunResultData["query"]>;
export type RunResultRepresentation = NonNullable<
  GetRunResultQuery["representation"]
>;

export interface RunResultRequest {
  readonly runId: string;
  readonly representation: RunResultRepresentation;
}

export const serviceExecutionApi = Object.freeze({
  async get(serviceId: string): Promise<Service> {
    const response = await asDhumiRequest(
      generatedGetService({
        client: dhumiClient,
        path: { service_id: serviceId },
        throwOnError: true,
      }),
    );
    return response.data;
  },

  async create(input: {
    readonly templateSlug: string;
    readonly name: string;
    readonly configuration: Record<string, unknown>;
  }): Promise<Service> {
    const body = {
      template_slug: input.templateSlug,
      name: input.name,
      configuration: input.configuration,
    };
    const lease = await acquireMutationIdempotency("service.create", body);
    const response = await asDhumiRequest(
      generatedCreateService({
        client: dhumiClient,
        body,
        headers: { "Idempotency-Key": lease.headerValue },
        throwOnError: true,
      }),
    );
    completeMutationIdempotency(lease);
    return response.data;
  },
});

export const runsApi = Object.freeze({
  async list(
    filters: { readonly status?: RunStatus; readonly serviceId?: string } = {},
  ): Promise<RunPage> {
    const response = await asDhumiRequest(
      generatedListRuns({
        client: dhumiClient,
        query: {
          limit: MAX_PAGE_SIZE,
          ...(filters.status ? { status: filters.status } : {}),
          ...(filters.serviceId ? { service_id: filters.serviceId } : {}),
        },
        throwOnError: true,
      }),
    );
    return response.data;
  },

  async get(runId: string): Promise<Run> {
    const response = await asDhumiRequest(
      generatedGetRun({
        client: dhumiClient,
        path: { run_id: runId },
        throwOnError: true,
      }),
    );
    return response.data;
  },

  async create(
    serviceId: string,
    input: Record<string, unknown>,
  ): Promise<RunAccepted> {
    const body = { input };
    const lease = await acquireMutationIdempotency("run.create", {
      serviceId,
      body,
    });
    const response = await asDhumiRequest(
      generatedCreateRun({
        client: dhumiClient,
        path: { service_id: serviceId },
        body,
        headers: { "Idempotency-Key": lease.headerValue },
        throwOnError: true,
      }),
    );
    completeMutationIdempotency(lease);
    return response.data;
  },

  async cancel(runId: string): Promise<Run> {
    const lease = await acquireMutationIdempotency("run.cancel", { runId });
    const response = await asDhumiRequest(
      generatedCancelRun({
        client: dhumiClient,
        path: { run_id: runId },
        headers: { "Idempotency-Key": lease.headerValue },
        throwOnError: true,
      }),
    );
    completeMutationIdempotency(lease);
    return response.data;
  },

  async retry(runId: string): Promise<RunAccepted> {
    const lease = await acquireMutationIdempotency("run.retry", { runId });
    const response = await asDhumiRequest(
      generatedRetryRun({
        client: dhumiClient,
        path: { run_id: runId },
        headers: { "Idempotency-Key": lease.headerValue },
        throwOnError: true,
      }),
    );
    completeMutationIdempotency(lease);
    return response.data;
  },

  async events(runId: string): Promise<RunEventPage> {
    const response = await asDhumiRequest(
      generatedListRunEvents({
        client: dhumiClient,
        path: { run_id: runId },
        query: { limit: MAX_PAGE_SIZE },
        throwOnError: true,
      }),
    );
    return response.data;
  },

  async result(request: RunResultRequest): Promise<RunResult> {
    const response = await asDhumiRequest(
      generatedGetRunResult({
        client: dhumiClient,
        path: { run_id: request.runId },
        query: { representation: request.representation },
        throwOnError: true,
      }),
    );
    return response.data;
  },
});
