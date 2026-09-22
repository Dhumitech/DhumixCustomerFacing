import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";

type JsonObject = Record<string, unknown>;

interface RequestOptions {
  readonly method?: string;
  readonly authenticated?: boolean;
  readonly csrfProtected?: boolean;
  readonly idempotencyKey?: string;
  readonly body?: unknown;
  readonly expectedStatus: number;
}

interface ResponseRecord {
  readonly status: number;
  readonly json: unknown;
  readonly text: string;
}

interface DatabaseSnapshot {
  readonly services: number;
  readonly runs: number;
  readonly attempts: number;
  readonly outboxEvents: number;
  readonly qualificationPackets: number;
  readonly exportCandidates: number;
  readonly sampleVersions: number;
  readonly downloadAuthorizations: number;
  readonly downloadAudits: number;
}

const apiBaseUrl = (process.env.M3_CUSTOMER_API_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const credentialFile = process.env.M3_CUSTOMER_CREDENTIAL_FILE;
const databaseName = process.env.M3_CUSTOMER_DATABASE_NAME ?? "dhumi_dev";
const databasePassword = process.env.M3_CUSTOMER_DATABASE_PASSWORD;
const templateSlug = process.env.MARKETPLACE_SAMPLE_TEMPLATE_SLUG ?? "linkedin-posts";
const expectedTemplateVersion = Number(
  process.env.MARKETPLACE_SAMPLE_TEMPLATE_VERSION ?? "1",
);
const expectedSampleVersion = Number(
  process.env.MARKETPLACE_SAMPLE_VERSION ?? "3",
);
const expectedRecordCount = Number(
  process.env.MARKETPLACE_SAMPLE_RECORD_COUNT ?? "5",
);
const expectedFieldCount = Number(
  process.env.MARKETPLACE_SAMPLE_FIELD_COUNT ?? "37",
);
const expectedMaskedFieldCount = Number(
  process.env.MARKETPLACE_SAMPLE_MASKED_FIELD_COUNT ?? "11",
);
const verificationLabel = process.env.MARKETPLACE_SAMPLE_VERIFICATION_LABEL ??
  "LinkedIn Posts provider sample";

if (credentialFile === undefined || credentialFile.trim() === "") {
  throw new Error("M3_CUSTOMER_CREDENTIAL_FILE is required.");
}
if (databasePassword === undefined || databasePassword === "") {
  throw new Error("M3_CUSTOMER_DATABASE_PASSWORD is required.");
}
if (
  !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(templateSlug) ||
  ![expectedTemplateVersion, expectedSampleVersion, expectedRecordCount,
    expectedFieldCount, expectedMaskedFieldCount].every((value) =>
      Number.isSafeInteger(value) && value > 0)
) {
  throw new Error("Marketplace sample verification configuration is invalid.");
}

const credentialText = await readFile(credentialFile, "utf8");
const email = /^Email:\s*(\S+)\s*$/im.exec(credentialText)?.[1];
const password = /^Password:\s*(\S.*)\s*$/im.exec(credentialText)?.[1];
if (email === undefined || password === undefined) {
  throw new Error("Credential file must contain Email: and Password: lines.");
}

const cookies = new Map<string, string>();
let accessToken: string | undefined;
let csrfToken: string | undefined;
let loggedOut = false;

function pass(name: string, evidence: string): void {
  console.log(`[PASS] ${name} - ${evidence}`);
}

function requireCondition(condition: unknown, name: string, evidence: string): asserts condition {
  if (!condition) {
    throw new Error(`${name}: ${evidence}`);
  }
}

function object(value: unknown, name: string): JsonObject {
  requireCondition(
    typeof value === "object" && value !== null && !Array.isArray(value),
    name,
    "expected a JSON object",
  );
  return value as JsonObject;
}

function array(value: unknown, name: string): unknown[] {
  requireCondition(Array.isArray(value), name, "expected an array");
  return value;
}

function string(value: unknown, name: string): string {
  requireCondition(typeof value === "string" && value !== "", name, "expected a non-empty string");
  return value;
}

function number(value: unknown, name: string): number {
  requireCondition(typeof value === "number" && Number.isFinite(value), name, "expected a finite number");
  return value;
}

function updateCookies(response: Response): void {
  const getSetCookie = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const values = typeof getSetCookie === "function"
    ? getSetCookie.call(response.headers)
    : response.headers.get("set-cookie") === null
      ? []
      : [response.headers.get("set-cookie") as string];

  for (const value of values) {
    const first = value.split(";", 1)[0] ?? "";
    const separator = first.indexOf("=");
    if (separator <= 0) continue;
    const name = first.slice(0, separator).trim();
    const cookieValue = first.slice(separator + 1).trim();
    if (/max-age=0/i.test(value) || cookieValue === "") cookies.delete(name);
    else cookies.set(name, cookieValue);
  }
}

function cookieHeader(): string | undefined {
  return cookies.size === 0
    ? undefined
    : [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function request(path: string, options: RequestOptions): Promise<ResponseRecord> {
  const headers = new Headers({ Accept: "application/json" });
  const cookie = cookieHeader();
  if (cookie !== undefined) headers.set("Cookie", cookie);
  if (options.authenticated === true) {
    requireCondition(accessToken !== undefined, path, "access token unavailable");
    headers.set("Authorization", `Bearer ${accessToken}`);
  }
  if (options.csrfProtected === true) {
    requireCondition(csrfToken !== undefined, path, "CSRF token unavailable");
    headers.set("X-CSRF-Token", csrfToken);
  }
  if (options.idempotencyKey !== undefined) headers.set("Idempotency-Key", options.idempotencyKey);
  if (options.body !== undefined) headers.set("Content-Type", "application/json");

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
  requireCondition(
    response.status === options.expectedStatus,
    `${options.method ?? "GET"} ${path}`,
    `expected ${options.expectedStatus}, received ${response.status}: ${text}`,
  );
  return { status: response.status, json, text };
}

async function databaseSnapshot(client: Client, tenantId: string): Promise<DatabaseSnapshot> {
  const result = await client.query<Record<string, string>>(
    `SELECT
       (SELECT count(*) FROM app.services WHERE tenant_id = $1::uuid)::text AS services,
       (SELECT count(*) FROM app.runs WHERE tenant_id = $1::uuid)::text AS runs,
       (SELECT count(*) FROM app.run_attempts WHERE tenant_id = $1::uuid)::text AS attempts,
       (SELECT count(*) FROM app.outbox_events WHERE tenant_id = $1::uuid)::text AS outbox_events,
       (SELECT count(*) FROM app.marketplace_qualification_packets)::text AS qualification_packets,
       (SELECT count(*) FROM app.marketplace_export_candidates)::text AS export_candidates,
       (SELECT count(*) FROM app.marketplace_sample_versions)::text AS sample_versions,
       (SELECT count(*) FROM app.marketplace_sample_download_authorizations WHERE tenant_id = $1::uuid)::text AS download_authorizations,
       (SELECT count(*) FROM app.audit_events WHERE tenant_id = $1::uuid AND action = 'marketplace.sample_download_authorize')::text AS download_audits`,
    [tenantId],
  );
  const row = result.rows[0];
  requireCondition(row !== undefined, "Database snapshot", "query returned no row");
  return {
    services: Number(row.services),
    runs: Number(row.runs),
    attempts: Number(row.attempts),
    outboxEvents: Number(row.outbox_events),
    qualificationPackets: Number(row.qualification_packets),
    exportCandidates: Number(row.export_candidates),
    sampleVersions: Number(row.sample_versions),
    downloadAuthorizations: Number(row.download_authorizations),
    downloadAudits: Number(row.download_audits),
  };
}

function assertMaskedRows(rows: unknown[], maskedFields: readonly string[], name: string): void {
  let markerCount = 0;
  for (const [index, value] of rows.entries()) {
    const row = object(value, `${name} row ${index + 1}`);
    for (const field of maskedFields) {
      const fieldValue = row[field];
      requireCondition(
        fieldValue === null || fieldValue === undefined || fieldValue === "***",
        name,
        `${field} disclosed a value outside the masked contract`,
      );
      if (fieldValue === "***") markerCount += 1;
    }
  }
  requireCondition(markerCount > 0, name, "no exact masked marker was observed");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else value += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") {
      row.push(value);
      value = "";
    } else if (character === "\n") {
      if (value.endsWith("\r")) value = value.slice(0, -1);
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else value += character;
  }
  if (value !== "" || row.length > 0) {
    row.push(value);
    rows.push(row);
  }
  return rows;
}

async function downloadAndVerify(
  format: "json" | "csv",
  body: JsonObject,
): Promise<{ readonly authorization: JsonObject; readonly bytes: Uint8Array }> {
  const response = await request(`/v1/catalog/templates/${templateSlug}/sample/downloads`, {
    method: "POST",
    authenticated: true,
    csrfProtected: true,
    idempotencyKey: `sample-${templateSlug}-${expectedSampleVersion}-${format}-${randomUUID()}`,
    body,
    expectedStatus: 201,
  });
  const authorization = object(response.json, `${format} authorization`);
  requireCondition(!response.text.includes("object_key"), `${format} authorization`, "object_key was exposed");
  requireCondition(
    authorization.sample_version === expectedSampleVersion,
    `${format} authorization`,
    "wrong sample version",
  );
  requireCondition(
    authorization.record_count === expectedRecordCount,
    `${format} authorization`,
    "wrong record count",
  );
  const downloadUrl = string(authorization.download_url, `${format} authorization`);
  const storedResponse = await fetch(downloadUrl);
  requireCondition(storedResponse.status === 200, `${format} signed download`, `received ${storedResponse.status}`);
  const bytes = new Uint8Array(await storedResponse.arrayBuffer());
  requireCondition(bytes.byteLength === number(authorization.byte_count, `${format} byte count`), `${format} bytes`, "byte count mismatch");
  requireCondition(sha256(bytes) === string(authorization.checksum, `${format} checksum`), `${format} bytes`, "checksum mismatch");
  pass(`${format.toUpperCase()} signed download`, `${bytes.byteLength} exact bytes; SHA-256 matched`);
  return { authorization, bytes };
}

const database = new Client({
  host: process.env.DATABASE_HOST ?? "localhost",
  port: Number(process.env.DATABASE_PORT ?? "5432"),
  database: databaseName,
  user: "postgres",
  password: databasePassword,
  ssl: false,
});

try {
  await database.connect();
  const databaseIdentity = await database.query<{ current_database: string }>("SELECT current_database()");
  requireCondition(databaseIdentity.rows[0]?.current_database === databaseName, "Database identity", "connected to the wrong database");
  pass("Database identity", databaseName);

  await request(`/v1/catalog/templates/${templateSlug}/sample?limit=100`, { expectedStatus: 401 });
  pass("Anonymous sample denial", "401");

  const signInResponse = await request("/v1/auth/sign-in", {
    method: "POST",
    body: { email, password },
    expectedStatus: 200,
  });
  const signIn = object(signInResponse.json, "Sign in");
  accessToken = string(signIn.access_token, "Sign in access token");
  csrfToken = string(signIn.csrf_token, "Sign in CSRF token");
  pass("Sign in", "authenticated browser session established");

  const workspaceResponse = await request("/v1/workspace", { authenticated: true, expectedStatus: 200 });
  const tenantId = string(object(workspaceResponse.json, "Workspace").id, "Workspace ID");
  const before = await databaseSnapshot(database, tenantId);

  const catalogueResponse = await request("/v1/catalog/templates?family=marketplace_dataset&limit=100", {
    authenticated: true,
    expectedStatus: 200,
  });
  const catalogueRows = array(object(catalogueResponse.json, "Marketplace catalogue").data, "Marketplace catalogue data");
  const offer = catalogueRows.map((value) => object(value, "Marketplace offer"))
    .find((value) => value.slug === templateSlug);
  requireCondition(offer !== undefined, "Marketplace catalogue", `${templateSlug} was absent`);
  requireCondition(
    offer.availability === "preview_available",
    "Marketplace catalogue",
    `${templateSlug} was not preview_available`,
  );
  pass("Marketplace catalogue", `${templateSlug} is preview_available`);

  const detailResponse = await request(`/v1/catalog/templates/${templateSlug}`, {
    authenticated: true,
    expectedStatus: 200,
  });
  const detail = object(detailResponse.json, "LinkedIn Posts detail");
  const marketplace = object(detail.marketplace, "Marketplace metadata");
  const sample = object(marketplace.sample, "Marketplace sample metadata");
  const capabilities = object(marketplace.capabilities, "Marketplace capabilities");
  const fields = array(marketplace.fields, "Marketplace fields").map((value) => object(value, "Marketplace field"));
  const maskedFields = fields.filter((field) => field.sample_visibility === "masked");
  const selectedFields = fields.map((field) => string(field.name, "Marketplace field name"));

  requireCondition(
    detail.version === expectedTemplateVersion,
    `${verificationLabel} detail`,
    "customer-visible preview Template version changed",
  );
  requireCondition(
    sample.version === expectedSampleVersion,
    `${verificationLabel} detail`,
    `active sample is not version ${expectedSampleVersion}`,
  );
  requireCondition(
    sample.record_count === expectedRecordCount,
    `${verificationLabel} detail`,
    `active sample does not contain ${expectedRecordCount} records`,
  );
  requireCondition(
    fields.length === expectedFieldCount,
    `${verificationLabel} detail`,
    `found ${fields.length} fields`,
  );
  requireCondition(
    maskedFields.length === expectedMaskedFieldCount,
    `${verificationLabel} detail`,
    `found ${maskedFields.length} masked fields`,
  );
  requireCondition(capabilities.sample_query === "available", "Marketplace capabilities", "sample query is unavailable");
  requireCondition(capabilities.sample_download === "available", "Marketplace capabilities", "sample download is unavailable");
  requireCondition(capabilities.full_export === "not_enabled", "Marketplace capabilities", "full export was enabled");
  for (const field of maskedFields) {
    requireCondition(array(field.allowed_operators, "Masked field operators").length === 0, "Masked field operators", `${String(field.name)} exposed an operator`);
  }
  pass(
    `${verificationLabel} detail`,
    `preview Template v${expectedTemplateVersion}; sample v${expectedSampleVersion}; ` +
      `${expectedRecordCount} records; ${expectedFieldCount} fields; ` +
      `${expectedMaskedFieldCount} masked; full export disabled`,
  );

  const sampleResponse = await request(`/v1/catalog/templates/${templateSlug}/sample?limit=100`, {
    authenticated: true,
    expectedStatus: 200,
  });
  const samplePage = object(sampleResponse.json, "Stored sample");
  const sampleRows = array(samplePage.rows, "Stored sample rows");
  requireCondition(
    samplePage.sample_version === expectedSampleVersion,
    "Stored sample",
    "wrong sample version",
  );
  requireCondition(
    sampleRows.length === expectedRecordCount,
    "Stored sample",
    `returned ${sampleRows.length} rows`,
  );
  assertMaskedRows(sampleRows, maskedFields.map((field) => string(field.name, "Masked field name")), "Stored sample masking");
  pass(
    "Stored sample",
    `${expectedRecordCount} rows returned from immutable sample v${expectedSampleVersion} with masking intact`,
  );

  const visibleFilterField = fields.find((field) =>
    field.sample_visibility === "visible" &&
    array(field.allowed_operators, "Visible field operators").includes("=") &&
    sampleRows.some((value) => typeof object(value, "Stored sample row")[String(field.name)] === "string"),
  );
  requireCondition(visibleFilterField !== undefined, "Local filter", "no evidence-backed visible equality field was available");
  const visibleFilterName = string(visibleFilterField.name, "Visible filter field");
  const filterValue = sampleRows
    .map((value) => object(value, "Stored sample row")[visibleFilterName])
    .find((value): value is string => typeof value === "string");
  requireCondition(filterValue !== undefined, "Local filter", "no filter value was available");

  const queryBody = {
    expected_sample_version: expectedSampleVersion,
    selected_fields: selectedFields,
    filter: { name: visibleFilterName, operator: "=", value: filterValue },
    page: { limit: 100 },
  };
  const queryResponse = await request(`/v1/catalog/templates/${templateSlug}/sample/query`, {
    method: "POST",
    authenticated: true,
    csrfProtected: true,
    body: queryBody,
    expectedStatus: 200,
  });
  const queryResult = object(queryResponse.json, "Filtered sample");
  const queryRows = array(queryResult.rows, "Filtered sample rows");
  requireCondition(number(queryResult.matches_in_sample, "Filtered match count") >= 1, "Local filter", "exact value did not match any sample row");
  assertMaskedRows(queryRows, maskedFields.map((field) => string(field.name, "Masked field name")), "Filtered sample masking");
  pass("Local filter", `${visibleFilterName} equality filter executed against stored sample only`);

  const maskedName = string(maskedFields[0]?.name, "Masked field name");
  await request(`/v1/catalog/templates/${templateSlug}/sample/query`, {
    method: "POST",
    authenticated: true,
    csrfProtected: true,
    body: {
      expected_sample_version: expectedSampleVersion,
      selected_fields: selectedFields,
      filter: { name: maskedName, operator: "=", value: "forbidden" },
      page: { limit: 100 },
    },
    expectedStatus: 422,
  });
  pass("Masked-field filter rejection", `${maskedName} rejected with 422`);

  await request(`/v1/catalog/templates/${templateSlug}/sample/query`, {
    method: "POST",
    authenticated: true,
    csrfProtected: true,
    body: {
      expected_sample_version: expectedSampleVersion,
      selected_fields: selectedFields,
      sort: [{ field: maskedName, direction: "asc" }],
      page: { limit: 100 },
    },
    expectedStatus: 422,
  });
  pass("Masked-field sort rejection", `${maskedName} rejected with 422`);

  const downloadBodyBase = {
    expected_sample_version: expectedSampleVersion,
    selected_fields: selectedFields,
    record_limit: expectedRecordCount,
  };
  const jsonDownload = await downloadAndVerify("json", { ...downloadBodyBase, format: "json" });
  const jsonRows = JSON.parse(new TextDecoder().decode(jsonDownload.bytes)) as unknown;
  const jsonRecords = array(jsonRows, "JSON download records");
  requireCondition(
    jsonRecords.length === expectedRecordCount,
    "JSON download",
    "wrong record count",
  );
  assertMaskedRows(jsonRecords, maskedFields.map((field) => string(field.name, "Masked field name")), "JSON download masking");

  const csvDownload = await downloadAndVerify("csv", { ...downloadBodyBase, format: "csv" });
  const csvRows = parseCsv(new TextDecoder().decode(csvDownload.bytes));
  requireCondition(
    csvRows.length === expectedRecordCount + 1,
    "CSV download",
    `expected header plus ${expectedRecordCount} rows, found ${csvRows.length}`,
  );
  requireCondition(JSON.stringify(csvRows[0]) === JSON.stringify(selectedFields), "CSV download", "header did not preserve selected-field order");
  const maskedIndexes = maskedFields.map((field) => selectedFields.indexOf(string(field.name, "Masked field name")));
  let csvMaskMarkers = 0;
  for (const row of csvRows.slice(1)) {
    for (const index of maskedIndexes) {
      const value = row[index];
      requireCondition(value === "" || value === "***", "CSV download masking", `masked column disclosed ${String(value)}`);
      if (value === "***") csvMaskMarkers += 1;
    }
  }
  requireCondition(csvMaskMarkers > 0, "CSV download masking", "no exact masked marker was observed");
  pass("JSON/CSV masking", "both bounded representations preserve the pre-purchase mask");

  const after = await databaseSnapshot(database, tenantId);
  for (const key of [
    "services", "runs", "attempts", "outboxEvents", "qualificationPackets", "exportCandidates", "sampleVersions",
  ] as const) {
    requireCondition(after[key] === before[key], "Database non-execution proof", `${key} changed from ${before[key]} to ${after[key]}`);
  }
  requireCondition(
    after.downloadAuthorizations === before.downloadAuthorizations + 2,
    "Download authorization persistence",
    `expected two authorizations, observed ${after.downloadAuthorizations - before.downloadAuthorizations}`,
  );
  requireCondition(
    after.downloadAudits === before.downloadAudits + 2,
    "Download audit persistence",
    `expected two audits, observed ${after.downloadAudits - before.downloadAudits}`,
  );
  pass("Database non-execution proof", "Services, Runs, Attempts, outbox, qualification packets, export candidates and sample versions unchanged");
  pass("Download persistence", "exactly two Tenant-owned authorizations and two audits recorded");
  pass("Bright Data calls", "0; workers stopped, controlled driver, qualification state unchanged");

  await request("/v1/auth/logout", {
    method: "POST",
    authenticated: true,
    csrfProtected: true,
    expectedStatus: 204,
  });
  loggedOut = true;
  pass("Logout", "204");
  console.log(
    `SUCCESS: ${verificationLabel} v${expectedSampleVersion} customer path passed.`,
  );
} finally {
  if (!loggedOut && accessToken !== undefined && csrfToken !== undefined) {
    try {
      await request("/v1/auth/logout", {
        method: "POST",
        authenticated: true,
        csrfProtected: true,
        expectedStatus: 204,
      });
    } catch {
      console.error("[CLEANUP FAILED] Browser session logout did not complete.");
    }
  }
  await database.end();
}
