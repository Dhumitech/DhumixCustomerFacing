import { guardOrganizationAction, organizationHeaders } from "./organizationScope";
import { tokenStore } from "../session/tokenStore";
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

function currentCsrfToken(): string {
  const session = tokenStore.getSnapshot();
  if (session === null) {
    throw new Error("An authenticated browser session is required.");
  }
  return session.csrf_token;
}

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
    const scope = organizationHeaders();
    const response = await asDhumiRequest(
      generatedGetService({
        client: dhumiClient, headers: scope,
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
    const scope = organizationHeaders();
    guardOrganizationAction(scope);
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
        headers: { ...scope,
          "Idempotency-Key": lease.headerValue,
          "X-CSRF-Token": currentCsrfToken(),
        },
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
    const scope = organizationHeaders();
    const response = await asDhumiRequest(
      generatedListRuns({
        client: dhumiClient, headers: scope,
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
    const scope = organizationHeaders();
    const response = await asDhumiRequest(
      generatedGetRun({
        client: dhumiClient, headers: scope,
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
    const scope = organizationHeaders();
    guardOrganizationAction(scope);
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
        headers: { ...scope,
          "Idempotency-Key": lease.headerValue,
          "X-CSRF-Token": currentCsrfToken(),
        },
        throwOnError: true,
      }),
    );
    completeMutationIdempotency(lease);
    return response.data;
  },

  async cancel(runId: string): Promise<Run> {
    const scope = organizationHeaders();
    guardOrganizationAction(scope);
    const lease = await acquireMutationIdempotency("run.cancel", { runId });
    const response = await asDhumiRequest(
      generatedCancelRun({
        client: dhumiClient,
        path: { run_id: runId },
        headers: { ...scope,
          "Idempotency-Key": lease.headerValue,
          "X-CSRF-Token": currentCsrfToken(),
        },
        throwOnError: true,
      }),
    );
    completeMutationIdempotency(lease);
    return response.data;
  },

  async retry(runId: string): Promise<RunAccepted> {
    const scope = organizationHeaders();
    guardOrganizationAction(scope);
    const lease = await acquireMutationIdempotency("run.retry", { runId });
    const response = await asDhumiRequest(
      generatedRetryRun({
        client: dhumiClient,
        path: { run_id: runId },
        headers: { ...scope,
          "Idempotency-Key": lease.headerValue,
          "X-CSRF-Token": currentCsrfToken(),
        },
        throwOnError: true,
      }),
    );
    completeMutationIdempotency(lease);
    return response.data;
  },

  async events(runId: string): Promise<RunEventPage> {
    const scope = organizationHeaders();
    const response = await asDhumiRequest(
      generatedListRunEvents({
        client: dhumiClient, headers: scope,
        path: { run_id: runId },
        query: { limit: MAX_PAGE_SIZE },
        throwOnError: true,
      }),
    );
    return response.data;
  },

  async result(request: RunResultRequest): Promise<RunResult> {
    const scope = organizationHeaders();
    const response = await asDhumiRequest(
      generatedGetRunResult({
        client: dhumiClient, headers: scope,
        path: { run_id: request.runId },
        query: { representation: request.representation },
        throwOnError: true,
      }),
    );
    return response.data;
  },
});
