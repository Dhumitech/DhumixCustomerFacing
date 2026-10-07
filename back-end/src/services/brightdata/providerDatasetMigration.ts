import type { ProviderReferenceProtector, ProtectedProviderReference } from "./providerReferenceProtector.js";
import { providerMappingAad } from "./providerExecutionPlanRepository.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Dataset-only context; snapshot/Attempt AAD remains unchanged. */
export function templateDatasetAad(templateVersionId: string): Buffer {
  if (!uuid.test(templateVersionId)) throw new TypeError("Template version must be a UUID");
  return Buffer.from(`dhumi:template-dataset:v1:${templateVersionId}`, "utf8");
}

export class ProviderDatasetMigrationError extends Error {
  public constructor() { super("Private dataset migration verification failed"); this.name = "ProviderDatasetMigrationError"; }
}

/** No SQL/network/files or plaintext output. The operator owns transaction/application gates. */
export async function reencryptProviderDataset(input: {
  readonly protector: ProviderReferenceProtector;
  readonly templateVersionId: string;
  readonly sourceAadMappingId: string;
  readonly ciphertext: Buffer;
  readonly fingerprint: Buffer;
  readonly existingTarget?: ProtectedProviderReference;
}): Promise<ProtectedProviderReference> {
  if (!uuid.test(input.sourceAadMappingId)) throw new ProviderDatasetMigrationError();
  try {
    const targetAad = templateDatasetAad(input.templateVersionId);
    const plaintext = await input.protector.reveal(input.ciphertext, input.fingerprint, providerMappingAad(input.sourceAadMappingId));
    if (!/^gd_[a-z0-9]{8,128}$/.test(plaintext)) throw new ProviderDatasetMigrationError();
    const target = input.existingTarget ?? await input.protector.protect(plaintext, targetAad);
    const verified = await input.protector.reveal(target.ciphertext, target.fingerprint, targetAad);
    if (verified !== plaintext) throw new ProviderDatasetMigrationError();
    return { ciphertext: Buffer.from(target.ciphertext), fingerprint: Buffer.from(target.fingerprint) };
  } catch {
    // No original crypto error/cause/provider value escapes into operator logs.
    throw new ProviderDatasetMigrationError();
  }
}

/** Validate every row before an operator may persist any resulting binding. */
export async function reencryptProviderDatasets(input: {
  readonly protector: ProviderReferenceProtector;
  readonly rows: readonly {
    readonly templateVersionId: string;
    readonly sourceAadMappingId: string;
    readonly ciphertext: Buffer;
    readonly fingerprint: Buffer;
    readonly existingTarget?: ProtectedProviderReference;
  }[];
}): Promise<readonly { readonly templateVersionId: string; readonly binding: ProtectedProviderReference }[]> {
  const versions = new Set<string>();
  for (const row of input.rows) {
    if (!uuid.test(row.templateVersionId) || !uuid.test(row.sourceAadMappingId) || versions.has(row.templateVersionId)) throw new ProviderDatasetMigrationError();
    versions.add(row.templateVersionId);
  }
  const verified = [];
  for (const row of input.rows) verified.push({ templateVersionId: row.templateVersionId, binding: await reencryptProviderDataset({ ...row, protector: input.protector }) });
  return verified;
}
