import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

type JsonObject = Record<string, unknown>;

interface TestRecord {
  readonly name: string;
  readonly status: "PASS" | "FAIL" | "NOT_RUN";
  readonly evidence: string;
}

interface RequestOptions {
  readonly method?: string;
  readonly authenticated?: boolean;
  readonly csrfProtected?: boolean;
  readonly apiKey?: string;
  readonly idempotencyKey?: string;
  readonly body?: unknown;
  readonly expectedStatus: number;
}

interface ResponseRecord {
  readonly status: number;
  readonly json: unknown;
  readonly text: string;
}

const apiBaseUrl = (process.env.R4_API_BASE_URL ?? "http://127.0.0.1:3000").replace(
  /\/$/,
  "",
);
const frontendUrl = (process.env.R4_FRONTEND_URL ?? "http://localhost:5173").replace(
  /\/$/,
  "",
);
const credentialFile = process.env.R4_CREDENTIAL_FILE;
const evidenceRunId = process.env.R4_RUN_ID;

if (credentialFile === undefined || credentialFile.trim() === "") {
  throw new Error("R4_CREDENTIAL_FILE must identify the ignored local credential file.");
}

if (evidenceRunId === undefined || evidenceRunId.trim() === "") {
  throw new Error("R4_RUN_ID must identify a previously completed evidence Run.");
}

const credentialText = await readFile(credentialFile, "utf8");
const email = /^Email:\s*(\S+)\s*$/im.exec(credentialText)?.[1];
const password = /^Password:\s*(\S.*)\s*$/im.exec(credentialText)?.[1];

if (email === undefined || password === undefined) {
  throw new Error("The credential file must contain Email: and Password: lines.");
}

const tests: TestRecord[] = [];
const cookies = new Map<string, string>();
let accessToken: string | undefined;
let csrfToken: string | undefined;
let disposableKeyId: string | undefined;
let disposableKeyRevoked = false;
let browserSessionLoggedOut = false;

function pass(name: string, evidence: string): void {
  tests.push({ name, status: "PASS", evidence });
  console.log(`[PASS] ${name} - ${evidence}`);
}

function notRun(name: string, evidence: string): void {
  tests.push({ name, status: "NOT_RUN", evidence });
  console.log(`[NOT RUN] ${name} - ${evidence}`);
}

function fail(name: string, evidence: string): never {
  tests.push({ name, status: "FAIL", evidence });
  throw new Error(`${name}: ${evidence}`);
}

function requireCondition(
  condition: unknown,
  name: string,
  evidence: string,
): asserts condition {
  if (!condition) {
    fail(name, evidence);
  }
}

function object(value: unknown, name: string): JsonObject {
  requireCondition(
    typeof value === "object" && value !== null && !Array.isArray(value),
    name,
    "response was not a JSON object",
  );
  return value as JsonObject;
}

function array(value: unknown, name: string): unknown[] {
  requireCondition(Array.isArray(value), name, "response field was not an array");
  return value;
}

function string(value: unknown, name: string): string {
  requireCondition(typeof value === "string" && value !== "", name, "required string was absent");
  return value;
}

function number(value: unknown, name: string): number {
  requireCondition(typeof value === "number" && Number.isFinite(value), name, "required number was absent");
  return value;
}

function updateCookies(response: Response): void {
  const getSetCookie = (response.headers as Headers & {
    getSetCookie?: () => string[];
  }).getSetCookie;
  const values =
    typeof getSetCookie === "function"
      ? getSetCookie.call(response.headers)
      : response.headers.get("set-cookie") === null
        ? []
        : [response.headers.get("set-cookie") as string];

  for (const value of values) {
    const first = value.split(";", 1)[0] ?? "";
    const separator = first.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = first.slice(0, separator).trim();
    const cookieValue = first.slice(separator + 1).trim();
    if (/max-age=0/i.test(value) || cookieValue === "") {
      cookies.delete(name);
    } else {
      cookies.set(name, cookieValue);
    }
  }
}

function cookieHeader(): string | undefined {
  if (cookies.size === 0) {
    return undefined;
  }
  return [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function request(path: string, options: RequestOptions): Promise<ResponseRecord> {
  const headers = new Headers({ Accept: "application/json" });
  const cookie = cookieHeader();
  if (cookie !== undefined) {
    headers.set("Cookie", cookie);
  }
  if (options.apiKey !== undefined) {
    headers.set("Authorization", `Bearer ${options.apiKey}`);
  } else if (options.authenticated === true) {
    requireCondition(accessToken !== undefined, path, "browser access token was unavailable");
    headers.set("Authorization", `Bearer ${accessToken}`);
  }
  if (options.csrfProtected === true) {
    requireCondition(csrfToken !== undefined, path, "CSRF token was unavailable");
    headers.set("X-CSRF-Token", csrfToken);
  }
  if (options.idempotencyKey !== undefined) {
    headers.set("Idempotency-Key", options.idempotencyKey);
  }
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  updateCookies(response);
  const text = await response.text();
  let json: unknown = null;
  if (text !== "") {
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      json = null;
    }
  }
  if (response.status !== options.expectedStatus) {
    const problem = typeof json === "object" && json !== null ? (json as JsonObject) : {};
    const code = typeof problem.code === "string" ? ` code=${problem.code}` : "";
    throw new Error(
      `${options.method ?? "GET"} ${path} returned ${response.status}; expected ${options.expectedStatus}.${code}`,
    );
  }
  return { status: response.status, json, text };
}

async function downloadAndVerify(
  name: string,
  metadata: JsonObject,
): Promise<{ readonly byteCount: number; readonly checksum: string }> {
  const downloadUrl = string(metadata.download_url, `${name} metadata`);
  const expectedByteCount = number(metadata.byte_count, `${name} metadata`);
  const expectedChecksum = string(metadata.checksum, `${name} metadata`);
  const expiresAt = string(metadata.download_expires_at, `${name} metadata`);

  requireCondition(
    new Date(expiresAt).getTime() > Date.now(),
    `${name} signed-link expiry`,
    "download link was already expired",
  );
  const response = await fetch(downloadUrl, { headers: { Accept: "application/json" } });
  requireCondition(response.status === 200, `${name} download`, `storage returned ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const checksum = createHash("sha256").update(bytes).digest("hex");
  requireCondition(
    bytes.byteLength === expectedByteCount,
    `${name} byte count`,
    `downloaded ${bytes.byteLength}; API declared ${expectedByteCount}`,
  );
  requireCondition(
    checksum === expectedChecksum,
    `${name} checksum`,
    "download checksum did not match the API metadata",
  );
  pass(`${name} exact download`, `${bytes.byteLength} bytes; SHA-256 matched`);
  return { byteCount: bytes.byteLength, checksum };
}

async function run(): Promise<void> {
  const frontendResponse = await fetch(frontendUrl);
  requireCondition(frontendResponse.status === 200, "Frontend availability", `HTTP ${frontendResponse.status}`);
  pass("Frontend availability", `${frontendUrl} returned HTTP 200`);

  const statusResponse = await request("/v1/status", { expectedStatus: 200 });
  const platformStatus = object(statusResponse.json, "Platform status");
  requireCondition(platformStatus.state === "operational", "Platform status", `state=${String(platformStatus.state)}`);
  const products = array(platformStatus.products, "Platform status").map((value) => object(value, "Product status"));
  const scraperStatus = products.find((value) => value.family === "scraper_library");
  requireCondition(scraperStatus?.state === "operational", "Scraper Library status", "not operational");
  pass("Platform and product status", "platform=operational; scraper_library=operational");

  const unauthorizedWorkspace = await request("/v1/workspace", { expectedStatus: 401 });
  const unauthorizedProblem = object(unauthorizedWorkspace.json, "Anonymous workspace denial");
  requireCondition(
    unauthorizedProblem.code === "AUTHENTICATION_REQUIRED",
    "Anonymous workspace denial",
    `code=${String(unauthorizedProblem.code)}`,
  );
  pass("Anonymous workspace denial", "HTTP 401 AUTHENTICATION_REQUIRED");

  const signInResponse = await request("/v1/auth/sign-in", {
    method: "POST",
    expectedStatus: 200,
    body: { email, password },
  });
  const signIn = object(signInResponse.json, "Sign in");
  accessToken = string(signIn.access_token, "Sign in");
  csrfToken = string(signIn.csrf_token, "Sign in");
  requireCondition(cookies.size > 0, "Sign in", "HttpOnly refresh cookie was not issued");
  requireCondition(
    !Object.hasOwn(signIn, "refresh_token") && Object.keys(signIn).length === 4,
    "Sign in response boundary",
    "response exposed an unexpected field",
  );
  pass("Sign in", "browser bearer, CSRF token and HttpOnly refresh cookie issued");

  const initialAccessToken = accessToken;
  const initialCsrfToken = csrfToken;
  const initialCookieFingerprint = createHash("sha256")
    .update(JSON.stringify([...cookies.entries()].sort()), "utf8")
    .digest("hex");
  const refreshResponse = await request("/v1/auth/refresh", {
    method: "POST",
    expectedStatus: 200,
    csrfProtected: true,
  });
  const refresh = object(refreshResponse.json, "Session refresh");
  accessToken = string(refresh.access_token, "Session refresh");
  csrfToken = string(refresh.csrf_token, "Session refresh");
  requireCondition(
    accessToken !== initialAccessToken,
    "Session refresh rotation",
    "access token did not rotate",
  );
  requireCondition(
    csrfToken === initialCsrfToken,
    "Session-bound CSRF continuity",
    "CSRF token changed even though the auth session ID is stable",
  );
  const refreshedCookieFingerprint = createHash("sha256")
    .update(JSON.stringify([...cookies.entries()].sort()), "utf8")
    .digest("hex");
  requireCondition(
    refreshedCookieFingerprint !== initialCookieFingerprint,
    "Refresh-cookie rotation",
    "refresh cookie did not rotate",
  );
  pass(
    "Session refresh",
    "access token and refresh cookie rotated; session-bound CSRF token remained valid",
  );

  const workspaceResponse = await request("/v1/workspace", {
    expectedStatus: 200,
    authenticated: true,
  });
  const workspace = object(workspaceResponse.json, "Workspace");
  const tenantId = string(workspace.id, "Workspace");
  requireCondition(workspace.state === "active", "Workspace", `state=${String(workspace.state)}`);
  pass("Workspace", `active Tenant ${tenantId}`);

  const templatesResponse = await request(
    "/v1/catalog/templates?family=scraper_library&limit=100",
    { expectedStatus: 200, authenticated: true },
  );
  const templatesPage = object(templatesResponse.json, "Catalogue list");
  const templates = array(templatesPage.data, "Catalogue list").map((value) => object(value, "Template"));
  const amazonTemplate = templates.find(
    (value) => value.slug === "amazon-products-collect-by-url" && value.version === 4,
  );
  requireCondition(amazonTemplate !== undefined, "Catalogue list", "published Amazon Products v4 was absent");
  requireCondition(amazonTemplate.availability === "available", "Catalogue list", "Amazon Products v4 was unavailable");
  pass("Catalogue list", "published amazon-products-collect-by-url v4 is available");

  const templateResponse = await request(
    "/v1/catalog/templates/amazon-products-collect-by-url",
    { expectedStatus: 200, authenticated: true },
  );
  const template = object(templateResponse.json, "Catalogue detail");
  requireCondition(template.version === 4, "Catalogue detail", `version=${String(template.version)}`);
  requireCondition(typeof template.input_schema === "object", "Catalogue detail", "input schema was absent");
  pass("Catalogue detail", "immutable Template v4 and input schema returned");

  const servicesResponse = await request("/v1/services?limit=100", {
    expectedStatus: 200,
    authenticated: true,
  });
  const servicesPage = object(servicesResponse.json, "Service list");
  const services = array(servicesPage.data, "Service list").map((value) => object(value, "Service"));
  const v4Services = services.filter(
    (value) =>
      value.template_slug === "amazon-products-collect-by-url" &&
      value.template_version === 4 &&
      value.state === "active",
  );
  requireCondition(v4Services.length > 0, "Service list", "no active Amazon Products v4 Service was visible");
  pass("Service list", `${v4Services.length} active Amazon Products v4 Service(s) visible`);

  const runsBeforeResponse = await request("/v1/runs?limit=100", {
    expectedStatus: 200,
    authenticated: true,
  });
  const runsBeforePage = object(runsBeforeResponse.json, "Run list");
  const runsBefore = array(runsBeforePage.data, "Run list").map((value) => object(value, "Run"));
  const runBefore = runsBefore.find((value) => value.id === evidenceRunId);
  requireCondition(runBefore !== undefined, "Run list", `evidence Run ${evidenceRunId} was not visible`);
  requireCondition(runBefore.status === "ready", "Run list", `evidence Run status=${String(runBefore.status)}`);
  const serviceId = string(runBefore.service_id, "Run list");
  pass("Run list", `ready evidence Run ${evidenceRunId} is Tenant-visible`);

  const serviceResponse = await request(`/v1/services/${serviceId}`, {
    expectedStatus: 200,
    authenticated: true,
  });
  const service = object(serviceResponse.json, "Service detail");
  requireCondition(
    service.template_slug === "amazon-products-collect-by-url" && service.template_version === 4,
    "Service detail",
    "evidence Run is not pinned to Amazon Products v4",
  );
  pass("Service detail", `Run belongs to active Template v4 Service ${serviceId}`);

  const runResponse = await request(`/v1/runs/${evidenceRunId}`, {
    expectedStatus: 200,
    authenticated: true,
  });
  const runDetail = object(runResponse.json, "Run detail");
  requireCondition(runDetail.status === "ready", "Run detail", `status=${String(runDetail.status)}`);
  const runCreatedAt = string(runDetail.created_at, "Run detail");
  const runCompletedAt = string(runDetail.completed_at, "Run detail");
  pass("Run detail", "terminal ready state returned; polling must stop");

  const eventsResponse = await request(`/v1/runs/${evidenceRunId}/events?limit=100`, {
    expectedStatus: 200,
    authenticated: true,
  });
  const eventsPage = object(eventsResponse.json, "Run events");
  const eventTypes = array(eventsPage.data, "Run events").map(
    (value) => string(object(value, "Run event").type, "Run event"),
  );
  for (const required of ["accepted", "started", "result_received", "progress", "completed"]) {
    requireCondition(eventTypes.includes(required), "Run events", `missing ${required}`);
  }
  requireCondition(eventTypes.at(-1) === "completed", "Run events", "last event was not terminal completed");
  pass("Run events", eventTypes.join(" -> "));

  notRun(
    "Cancel and retry mutations",
    "evidence Run is already ready; no eligible non-billable fixture was present and bright_data mode forbids creating one",
  );

  const normalizedResponse = await request(
    `/v1/runs/${evidenceRunId}/result?representation=normalized`,
    { expectedStatus: 200, authenticated: true },
  );
  const normalized = object(normalizedResponse.json, "Normalized result authorization");
  requireCondition(
    !normalizedResponse.text.includes("object_key"),
    "Normalized result boundary",
    "private object_key was exposed",
  );
  pass("Normalized result authorization", "short-lived metadata returned without object_key");

  const rawResponse = await request(`/v1/runs/${evidenceRunId}/result?representation=raw`, {
    expectedStatus: 200,
    authenticated: true,
  });
  const raw = object(rawResponse.json, "Raw result authorization");
  requireCondition(!rawResponse.text.includes("object_key"), "Raw result boundary", "private object_key was exposed");
  requireCondition(
    normalized.download_url !== raw.download_url,
    "Representation-specific signed links",
    "normalized and raw reused the same URL",
  );
  pass("Raw result authorization", "short-lived metadata returned without object_key");
  pass("Representation-specific links", "normalized and raw links are distinct");

  const normalizedDownload = await downloadAndVerify("Normalized result", normalized);
  const rawDownload = await downloadAndVerify("Raw result", raw);
  requireCondition(
    normalizedDownload.checksum !== rawDownload.checksum,
    "Representation integrity",
    "raw and normalized checksums unexpectedly matched",
  );
  pass("Representation integrity", "raw and normalized checksums are distinct");

  const from = new Date(new Date(runCreatedAt).getTime() - 60_000).toISOString();
  const to = new Date(new Date(runCompletedAt).getTime() + 60_000).toISOString();
  const usageQuery = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const usageSummaryResponse = await request(`/v1/usage/summary?${usageQuery}`, {
    expectedStatus: 200,
    authenticated: true,
  });
  const usageSummary = object(usageSummaryResponse.json, "Usage summary");
  requireCondition(array(usageSummary.items, "Usage summary").length > 0, "Usage summary", "no usage was returned");
  pass("Usage summary", `state=${String(usageSummary.state)}; time window brackets the evidence Run`);

  const usageEventsResponse = await request(`/v1/usage/events?${usageQuery}&limit=100`, {
    expectedStatus: 200,
    authenticated: true,
  });
  const usageEventsPage = object(usageEventsResponse.json, "Usage events");
  const matchingUsage = array(usageEventsPage.data, "Usage events")
    .map((value) => object(value, "Usage event"))
    .filter((value) => value.run_id === evidenceRunId);
  requireCondition(matchingUsage.length === 1, "Usage events", `found ${matchingUsage.length}; expected exactly one`);
  requireCondition(matchingUsage[0]?.outcome === "succeeded", "Usage events", "evidence Run usage did not succeed");
  pass("Usage events", "exactly one successful usage event traces to the evidence Run");

  const keysBeforeResponse = await request("/v1/keys?limit=100", {
    expectedStatus: 200,
    authenticated: true,
  });
  const keysBeforePage = object(keysBeforeResponse.json, "API-key list");
  const keyCountBefore = array(keysBeforePage.data, "API-key list").length;
  pass("API-key list", `${keyCountBefore} existing key record(s) visible before disposable-key test`);

  const keyCreateResponse = await request("/v1/keys", {
    method: "POST",
    expectedStatus: 201,
    authenticated: true,
    csrfProtected: true,
    idempotencyKey: `r4-key-${randomUUID()}`,
    body: {
      name: `R4 disposable ${new Date().toISOString()}`,
      scopes: [
        "catalog:read",
        "results:read",
        "runs:read",
        "services:read",
        "usage:read",
      ],
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    },
  });
  const createdKey = object(keyCreateResponse.json, "API-key creation");
  disposableKeyId = string(createdKey.id, "API-key creation");
  const disposableSecret = string(createdKey.secret, "API-key creation");
  requireCondition(createdKey.state === "active", "API-key creation", "key was not active");
  pass("API-key creation", `disposable key ${disposableKeyId} created; plaintext secret not logged`);

  const keyAuthCatalogue = await request(
    "/v1/catalog/templates?family=scraper_library&limit=1",
    { expectedStatus: 200, apiKey: disposableSecret },
  );
  requireCondition(
    array(object(keyAuthCatalogue.json, "API-key authentication").data, "API-key authentication").length > 0,
    "API-key authentication",
    "catalogue returned no data",
  );
  pass("API-key authentication", "disposable catalog:read key authenticated successfully");

  const keysActiveResponse = await request("/v1/keys?limit=100", {
    expectedStatus: 200,
    authenticated: true,
  });
  const activeKeys = array(object(keysActiveResponse.json, "API-key active list").data, "API-key active list").map(
    (value) => object(value, "API key"),
  );
  requireCondition(
    activeKeys.some((value) => value.id === disposableKeyId && value.state === "active"),
    "API-key active list",
    "disposable key was absent or inactive",
  );
  pass("API-key active list", "disposable key is visible and active");

  await request(`/v1/keys/${disposableKeyId}`, {
    method: "DELETE",
    expectedStatus: 204,
    authenticated: true,
    csrfProtected: true,
  });
  disposableKeyRevoked = true;
  pass("API-key revocation", `disposable key ${disposableKeyId} revoked with HTTP 204`);

  const revokedKeyAuth = await request(
    "/v1/catalog/templates?family=scraper_library&limit=1",
    { expectedStatus: 401, apiKey: disposableSecret },
  );
  const revokedProblem = object(revokedKeyAuth.json, "Revoked API-key denial");
  requireCondition(
    revokedProblem.code === "AUTHENTICATION_REQUIRED",
    "Revoked API-key denial",
    `code=${String(revokedProblem.code)}`,
  );
  pass("Revoked API-key denial", "revoked key returns HTTP 401 AUTHENTICATION_REQUIRED");

  const keysRevokedResponse = await request("/v1/keys?limit=100", {
    expectedStatus: 200,
    authenticated: true,
  });
  const revokedKeys = array(object(keysRevokedResponse.json, "API-key revoked list").data, "API-key revoked list").map(
    (value) => object(value, "API key"),
  );
  requireCondition(
    revokedKeys.some((value) => value.id === disposableKeyId && value.state === "revoked"),
    "API-key revoked list",
    "disposable key was absent or not revoked",
  );
  pass("API-key revoked list", "disposable key remains traceable with revoked state");

  const runsAfterResponse = await request("/v1/runs?limit=100", {
    expectedStatus: 200,
    authenticated: true,
  });
  const runsAfter = array(object(runsAfterResponse.json, "Run list after regression").data, "Run list after regression").map(
    (value) => object(value, "Run"),
  );
  const beforeIds = runsBefore.map((value) => string(value.id, "Run list")).sort();
  const afterIds = runsAfter.map((value) => string(value.id, "Run list")).sort();
  requireCondition(
    JSON.stringify(beforeIds) === JSON.stringify(afterIds),
    "Zero-Run-mutation boundary",
    "Run IDs changed during the regression",
  );
  pass("Zero-Run-mutation boundary", "Run ID set is unchanged; no Run was created, cancelled or retried");

  await request("/v1/auth/logout", {
    method: "POST",
    expectedStatus: 204,
    authenticated: true,
    csrfProtected: true,
  });
  browserSessionLoggedOut = true;
  pass("Logout", "browser session revoked with HTTP 204");

  const postLogout = await request("/v1/workspace", {
    expectedStatus: 401,
    authenticated: true,
  });
  const postLogoutProblem = object(postLogout.json, "Post-logout denial");
  requireCondition(
    postLogoutProblem.code === "AUTHENTICATION_REQUIRED",
    "Post-logout denial",
    `code=${String(postLogoutProblem.code)}`,
  );
  pass("Post-logout denial", "revoked browser bearer returns HTTP 401");

  pass(
    "Provider-call boundary",
    "test invoked no create-Run, retry, cancel, Outbox, Job Manager or provider endpoint",
  );
}

try {
  await run();
} finally {
  if (
    disposableKeyId !== undefined &&
    !disposableKeyRevoked &&
    accessToken !== undefined &&
    csrfToken !== undefined
  ) {
    try {
      await request(`/v1/keys/${disposableKeyId}`, {
        method: "DELETE",
        expectedStatus: 204,
        authenticated: true,
        csrfProtected: true,
      });
      disposableKeyRevoked = true;
      console.log(`[CLEANUP] Revoked disposable API key ${disposableKeyId}.`);
    } catch (error) {
      console.error(`[CLEANUP FAILED] Disposable API key ${disposableKeyId} may still be active.`);
      console.error(error instanceof Error ? error.message : String(error));
    }
  }
  if (!browserSessionLoggedOut && accessToken !== undefined && csrfToken !== undefined) {
    try {
      await request("/v1/auth/logout", {
        method: "POST",
        expectedStatus: 204,
        authenticated: true,
        csrfProtected: true,
      });
      browserSessionLoggedOut = true;
      console.log("[CLEANUP] Revoked the R4 browser session.");
    } catch (error) {
      console.error("[CLEANUP FAILED] The R4 browser session may still be active.");
      console.error(error instanceof Error ? error.message : String(error));
    }
  }
}

const passed = tests.filter((test) => test.status === "PASS").length;
const failed = tests.filter((test) => test.status === "FAIL").length;
const notExecuted = tests.filter((test) => test.status === "NOT_RUN").length;
console.log(`R4 SUMMARY: ${passed} passed, ${failed} failed, ${notExecuted} not run.`);
console.log(
  `R4_RESULT_JSON=${JSON.stringify({
    status: failed === 0 ? "passed_with_declared_exclusion" : "failed",
    passed,
    failed,
    not_run: notExecuted,
    evidence_run_id: evidenceRunId,
    provider_submissions: 0,
    tests,
  })}`,
);

if (failed > 0) {
  process.exitCode = 1;
}
