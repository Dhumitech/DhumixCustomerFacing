const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ResultArtifactKind = "raw" | "normalized";

export interface ResultObjectIdentity {
  readonly tenantId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly kind: ResultArtifactKind;
  readonly artifactVersion: number;
}

function requireUuid(name: string, value: string): string {
  if (!UUID_PATTERN.test(value)) throw new TypeError(`${name} must be a valid UUID`);
  return value.toLowerCase();
}

function requireKind(value: string): ResultArtifactKind {
  if (value !== "raw" && value !== "normalized") {
    throw new TypeError("kind must be raw or normalized");
  }
  return value;
}

export function createResultObjectKey(identity: ResultObjectIdentity): string {
  const tenantId = requireUuid("tenantId", identity.tenantId);
  const runId = requireUuid("runId", identity.runId);
  const attemptId = requireUuid("attemptId", identity.attemptId);
  const kind = requireKind(identity.kind);
  if (!Number.isSafeInteger(identity.artifactVersion) || identity.artifactVersion < 1) {
    throw new TypeError("artifactVersion must be a positive safe integer");
  }

  return (
    `tenants/${tenantId}/runs/${runId}/attempts/${attemptId}/` +
    `${kind}/v${identity.artifactVersion}/result`
  );
}

export function isResultObjectKeyForRun(
  objectKey: string,
  tenantId: string,
  runId: string,
): boolean {
  if (!UUID_PATTERN.test(tenantId) || !UUID_PATTERN.test(runId)) return false;
  const escapedTenant = tenantId.toLowerCase().replaceAll("-", "\\-");
  const escapedRun = runId.toLowerCase().replaceAll("-", "\\-");
  const expression = new RegExp(
    `^tenants/${escapedTenant}/runs/${escapedRun}/` +
      "attempts/[0-9a-f]{8}\\-[0-9a-f]{4}\\-[1-8][0-9a-f]{3}\\-" +
      "[89ab][0-9a-f]{3}\\-[0-9a-f]{12}/(?:raw|normalized)/v[1-9][0-9]*/result$",
    "i",
  );
  return expression.test(objectKey);
}
