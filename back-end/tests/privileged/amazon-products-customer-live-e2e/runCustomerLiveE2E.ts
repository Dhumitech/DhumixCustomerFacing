import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const API_ORIGIN = "http://127.0.0.1:3000";
const TEMPLATE_SLUG = "amazon-products-collect-by-url";
const RUNTIME_DIRECTORY = resolve(".runtime", "amazon-products-customer-live-e2e");
const STATE_PATH = resolve(RUNTIME_DIRECTORY, "state.json");
const REPORT_PATH = resolve(RUNTIME_DIRECTORY, "report.json");
const RESULT_PATH = resolve(RUNTIME_DIRECTORY, "normalized-result.json");
const INPUT_PATH = resolve(
  "tests",
  "privileged",
  "amazon-products-customer-live-e2e",
  "inputs",
  "six-products.json",
);
const TERMINAL_FAILURES = new Set(["failed", "canceled"]);
const MAX_WAIT_MS = 20 * 60 * 1_000;
const POLL_INTERVAL_MS = 3_000;

interface State {
  readonly executionId: string;
  readonly email: string;
  readonly password: string;
  readonly signupKey: string;
  readonly apiKeyCreateKey: string;
  readonly serviceCreateKey: string;
  runCreateKey: string;
  apiKeyId?: string;
  apiKeySecret?: string;
  serviceId?: string;
  runId?: string;
  failedPreEgressRunId?: string;
  failedPreEgressErrorCode?: string;
  completed?: boolean;
}

interface AuthResponse {
  readonly access_token: string;
  readonly csrf_token: string;
}

interface ApiKeyResponse {
  readonly id: string;
  readonly secret: string;
}

interface CatalogResponse {
  readonly data: readonly {
    readonly slug: string;
    readonly version: number;
    readonly availability: string;
  }[];
}

interface ServiceResponse {
  readonly id: string;
  readonly template_slug: string;
  readonly template_version: number;
  readonly state: string;
}

interface RunAcceptedResponse {
  readonly run_id: string;
  readonly status: string;
}

interface RunResponse {
  readonly id: string;
  readonly service_id: string;
  readonly status: string;
  readonly error_code: string | null;
  readonly retryable: boolean;
}

interface RunEventsResponse {
  readonly data: readonly {
    readonly id: string;
    readonly type: string;
    readonly message: string;
    readonly occurred_at: string;
  }[];
}

interface RunPageResponse {
  readonly data: readonly RunResponse[];
}

interface RunResultResponse {
  readonly run_id: string;
  readonly content_type: string;
  readonly byte_count: number;
  readonly checksum: string;
  readonly download_url: string;
  readonly download_expires_at: string;
}

interface UsageEventsResponse {
  readonly data: readonly {
    readonly id: string;
    readonly run_id: string;
    readonly meter: string;
    readonly quantity: number;
    readonly unit: string;
    readonly outcome: string;
  }[];
}

interface UsageSummaryResponse {
  readonly from: string;
  readonly to: string;
  readonly items: readonly {
    readonly meter: string;
    readonly quantity: number;
    readonly unit: string;
  }[];
  readonly state: string;
}

interface HttpResult<T> {
  readonly body: T;
  readonly headers: Headers;
}

function idempotencyKey(prefix: string, executionId: string): string {
  return `${prefix}:${executionId}`;
}

async function saveState(state: State): Promise<void> {
  await mkdir(RUNTIME_DIRECTORY, { recursive: true });
  await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function loadState(): Promise<State> {
  await mkdir(RUNTIME_DIRECTORY, { recursive: true });
  try {
    return JSON.parse(await readFile(STATE_PATH, "utf8")) as State;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const executionId = randomUUID();
  const state: State = {
    executionId,
    email: `amazon-live-${executionId}@example.test`,
    password: `Dhumi-Live-${randomBytes(24).toString("base64url")}!Aa1`,
    signupKey: idempotencyKey("signup", executionId),
    apiKeyCreateKey: idempotencyKey("key", executionId),
    serviceCreateKey: idempotencyKey("service", executionId),
    runCreateKey: idempotencyKey("run-six-products", executionId),
  };
  await saveState(state);
  return state;
}

async function requestJson<T>(
  path: string,
  expectedStatus: number,
  init: RequestInit = {},
): Promise<HttpResult<T>> {
  const response = await fetch(new URL(path, API_ORIGIN), {
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...init.headers,
    },
    redirect: "error",
  });
  const text = await response.text();
  if (response.status !== expectedStatus) {
    throw new Error(`HTTP ${response.status} for ${path}: ${text.slice(0, 1_000)}`);
  }
  return {
    body: (text.length === 0 ? undefined : JSON.parse(text)) as T,
    headers: response.headers,
  };
}

function cookieHeader(headers: Headers): string {
  const extended = headers as Headers & { getSetCookie?: () => string[] };
  const values = extended.getSetCookie?.() ?? [];
  const source = values.length > 0
    ? values
    : (headers.get("set-cookie") === null ? [] : [headers.get("set-cookie") as string]);
  return source.map((value) => value.split(";", 1)[0]).join("; ");
}

function bearer(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}` };
}

async function main(): Promise<void> {
  if (!process.argv.includes("--confirm-one-billable-six-target-run")) {
    throw new Error("LIVE_RUN_CONFIRMATION_REQUIRED");
  }
  const state = await loadState();
  const replaceFailureArgument = process.argv.find((value) =>
    value.startsWith("--replace-proven-pre-egress-run="),
  );
  const replaceFailureRunId = replaceFailureArgument?.split("=", 2)[1];
  if (state.completed === true) {
    process.stdout.write(await readFile(REPORT_PATH, "utf8"));
    return;
  }
  const input = JSON.parse(await readFile(INPUT_PATH, "utf8")) as {
    readonly targets: readonly { readonly url: string }[];
  };
  if (input.targets.length !== 6) throw new Error("LIVE_RUN_MUST_HAVE_EXACTLY_SIX_TARGETS");

  await requestJson("/v1/auth/signup", 202, {
    method: "POST",
    headers: { "idempotency-key": state.signupKey },
    body: JSON.stringify({
      email: state.email,
      password: state.password,
      workspace_name: "Amazon Products Live E2E",
      legal_acceptances: [{
        document_type: "terms_of_service",
        document_version: "2026-09-01",
        content_hash: "a".repeat(64),
        accepted: true,
      }],
    }),
  });
  const signedIn = await requestJson<AuthResponse>("/v1/auth/sign-in", 200, {
    method: "POST",
    body: JSON.stringify({ email: state.email, password: state.password }),
  });
  const accessToken = signedIn.body.access_token;
  const csrfToken = signedIn.body.csrf_token;
  const cookies = cookieHeader(signedIn.headers);

  if (state.apiKeySecret === undefined || state.apiKeyId === undefined) {
    const createdKey = await requestJson<ApiKeyResponse>("/v1/keys", 201, {
      method: "POST",
      headers: {
        ...bearer(accessToken),
        "x-csrf-token": csrfToken,
        "idempotency-key": state.apiKeyCreateKey,
      },
      body: JSON.stringify({
        name: "Amazon Products Live E2E",
        scopes: [
          "catalog:read",
          "results:read",
          "runs:read",
          "runs:write",
          "services:read",
          "services:write",
          "usage:read",
        ],
      }),
    });
    state.apiKeyId = createdKey.body.id;
    state.apiKeySecret = createdKey.body.secret;
    await saveState(state);
  }
  const apiKey = state.apiKeySecret;

  if (
    replaceFailureRunId !== undefined &&
    state.failedPreEgressRunId === undefined
  ) {
    if (state.runId !== replaceFailureRunId) {
      throw new Error("PRE_EGRESS_REPLACEMENT_RUN_ID_MISMATCH");
    }
    const failedRun = (await requestJson<RunResponse>(
      `/v1/runs/${state.runId}`,
      200,
      { headers: bearer(apiKey) },
    )).body;
    if (
      failedRun.status !== "failed" ||
      failedRun.error_code !== "SERVICE_UNAVAILABLE" ||
      failedRun.retryable !== false
    ) {
      throw new Error("RUN_IS_NOT_THE_PROVEN_PRE_EGRESS_CONFIGURATION_FAILURE");
    }
    state.failedPreEgressRunId = failedRun.id;
    state.failedPreEgressErrorCode = failedRun.error_code;
    delete state.runId;
    state.runCreateKey = idempotencyKey(
      "run-six-products-after-aad-lineage-fix",
      state.executionId,
    );
    await saveState(state);
  }

  const catalogue = await requestJson<CatalogResponse>(
    "/v1/catalog/templates?family=scraper_library&limit=100",
    200,
    { headers: bearer(apiKey) },
  );
  const template = catalogue.body.data.find((item) => item.slug === TEMPLATE_SLUG);
  if (template?.availability !== "available" || template.version !== 3) {
    throw new Error("PUBLISHED_PRODUCTS_TEMPLATE_NOT_AVAILABLE");
  }

  if (state.serviceId === undefined) {
    const service = await requestJson<ServiceResponse>("/v1/services", 201, {
      method: "POST",
      headers: {
        ...bearer(apiKey),
        "idempotency-key": state.serviceCreateKey,
      },
      body: JSON.stringify({
        template_slug: TEMPLATE_SLUG,
        name: "Six Amazon air-filter products",
        configuration: {},
      }),
    });
    if (
      service.body.template_slug !== TEMPLATE_SLUG ||
      service.body.template_version !== 3 ||
      service.body.state !== "active"
    ) {
      throw new Error("LIVE_SERVICE_CONTRACT_INVALID");
    }
    state.serviceId = service.body.id;
    await saveState(state);
  }

  if (state.runId === undefined) {
    const accepted = await requestJson<RunAcceptedResponse>(
      `/v1/services/${state.serviceId}/runs`,
      202,
      {
        method: "POST",
        headers: {
          ...bearer(apiKey),
          "idempotency-key": state.runCreateKey,
        },
        body: JSON.stringify({ input }),
      },
    );
    if (accepted.body.status !== "queued") throw new Error("LIVE_RUN_NOT_QUEUED");
    state.runId = accepted.body.run_id;
    await saveState(state);
  }

  const startedAt = Date.now();
  let run: RunResponse;
  for (;;) {
    run = (await requestJson<RunResponse>(`/v1/runs/${state.runId}`, 200, {
      headers: bearer(apiKey),
    })).body;
    if (run.status === "ready") break;
    if (TERMINAL_FAILURES.has(run.status)) {
      throw new Error(`LIVE_RUN_${run.status.toUpperCase()}:${run.error_code ?? "UNKNOWN"}`);
    }
    if (Date.now() - startedAt >= MAX_WAIT_MS) throw new Error("LIVE_RUN_POLL_TIMEOUT");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, POLL_INTERVAL_MS));
  }

  const events = (await requestJson<RunEventsResponse>(
    `/v1/runs/${state.runId}/events?limit=100`,
    200,
    { headers: bearer(apiKey) },
  )).body;
  const result = (await requestJson<RunResultResponse>(
    `/v1/runs/${state.runId}/result`,
    200,
    { headers: bearer(apiKey) },
  )).body;
  const downloaded = await fetch(result.download_url, { redirect: "error" });
  if (downloaded.status !== 200) {
    throw new Error(`SIGNED_DOWNLOAD_HTTP_${downloaded.status}`);
  }
  const resultBytes = Buffer.from(await downloaded.arrayBuffer());
  const checksum = createHash("sha256").update(resultBytes).digest("hex");
  if (resultBytes.byteLength !== result.byte_count || checksum !== result.checksum.toLowerCase()) {
    throw new Error("SIGNED_DOWNLOAD_INTEGRITY_MISMATCH");
  }
  await writeFile(RESULT_PATH, resultBytes, { mode: 0o600 });

  const runPage = (await requestJson<RunPageResponse>(
    `/v1/runs?service_id=${encodeURIComponent(state.serviceId)}&limit=100`,
    200,
    { headers: bearer(apiKey) },
  )).body;
  if (!runPage.data.some((candidate) => candidate.id === state.runId)) {
    throw new Error("LIVE_RUN_MISSING_FROM_SERVICE_FILTERED_LIST");
  }

  const usageFrom = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();
  const usageTo = new Date(Date.now() + 5 * 60 * 1_000).toISOString();
  const usageQuery = new URLSearchParams({
    from: usageFrom,
    to: usageTo,
  });
  const usageSummary = (await requestJson<UsageSummaryResponse>(
    `/v1/usage/summary?${usageQuery.toString()}`,
    200,
    { headers: bearer(apiKey) },
  )).body;
  const usage = (await requestJson<UsageEventsResponse>(
    `/v1/usage/events?${usageQuery.toString()}&limit=100`,
    200,
    { headers: bearer(apiKey) },
  )).body.data.filter((event) => event.run_id === state.runId);
  if (usage.length !== 1) throw new Error(`LIVE_RUN_USAGE_EVENT_COUNT_${usage.length}`);

  const report = {
    evidenceVersion: "amazon-products-customer-live-e2e-v1",
    productionPath: true,
    infrastructureAdapters: {
      objectStorage: "azurite",
      queue: "azure-service-bus-emulator",
      lease: "local-redis",
      secret: "non-production-environment-adapter",
    },
    providerBudget: {
      scrapeSubmissionsAuthorized: 1,
      targets: 6,
      automaticRetries: 0,
    },
    priorPreEgressFailure: state.failedPreEgressRunId === undefined
      ? null
      : {
          runId: state.failedPreEgressRunId,
          errorCode: state.failedPreEgressErrorCode,
          providerSubmissionMade: false,
        },
    serviceId: state.serviceId,
    runId: state.runId,
    runStatus: run.status,
    runRetryable: run.retryable,
    events: events.data.map((event) => ({
      id: event.id,
      type: event.type,
      message: event.message,
      occurredAt: event.occurred_at,
    })),
    result: {
      contentType: result.content_type,
      byteCount: result.byte_count,
      checksum: result.checksum,
      exactDownloadBytes: true,
      downloadExpiresAt: result.download_expires_at,
    },
    usage: usage.map((event) => ({
      id: event.id,
      meter: event.meter,
      quantity: event.quantity,
      unit: event.unit,
      outcome: event.outcome,
    })),
    usageSummary: {
      from: usageSummary.from,
      to: usageSummary.to,
      state: usageSummary.state,
      items: usageSummary.items,
    },
  };
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });

  await requestJson(`/v1/keys/${state.apiKeyId}`, 204, {
    method: "DELETE",
    headers: {
      ...bearer(accessToken),
      "x-csrf-token": csrfToken,
    },
  });
  await requestJson("/v1/auth/logout", 204, {
    method: "POST",
    headers: {
      ...bearer(accessToken),
      "x-csrf-token": csrfToken,
      ...(cookies === "" ? {} : { cookie: cookies }),
    },
  });
  delete state.apiKeySecret;
  state.completed = true;
  await saveState(state);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main();
