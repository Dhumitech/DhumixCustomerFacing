import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { projectDeploymentEnvironment } from "../../src/deployment/environment.ts";
import {
  addResultStorageChecks,
  resultStorageConfiguration,
  resultStorageEnvironmentShape,
} from "../../src/config/resultStorageEnvironment.ts";
import { configuredAzureBlobService } from "../../src/services/storage/resultStorageComposition.ts";

// Storage-only qualification. Never loads the host .env or connects to SQL,
// queues, the provider or email. Default to the canonical private Azure profile.
const schema = z.object({
  ...resultStorageEnvironmentShape,
  RESULT_STORAGE_DRIVER: z.literal("azure_blob"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("test"),
  RESULT_DOWNLOAD_PROXY_URL: z.preprocess(value => value === "" ? undefined : value, z.url().optional()),
}).superRefine(addResultStorageChecks);

try {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some(arg => !arg.startsWith("--env="))) throw new Error("Unsupported profile argument");
  const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const profile = path.resolve(backend, args[0]?.slice(6) || ".env.azure");
  const source = fs.existsSync(profile) ? parseEnv(fs.readFileSync(profile, "utf8")) :
    (args.length === 0 ? process.env : (() => { throw new Error("Explicit profile not found"); })());
  const parsed = schema.safeParse(projectDeploymentEnvironment("storage", source, {}));
  if (!parsed.success) {
    console.error(JSON.stringify({ status: "failed", stage: "configuration",
      fields: [...new Set(parsed.error.issues.map(issue => issue.path.join(".")))] }));
    process.exitCode = 1;
  } else {
    const config = resultStorageConfiguration(parsed.data);
    const { service, container } = await configuredAzureBlobService(config);
    await container.listBlobsFlat().byPage({ maxPageSize: 1 }).next();
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.valueOf() + config.downloadTtlSeconds * 1_000);
    await service.getUserDelegationKey(new Date(issuedAt.valueOf() - 30_000), expiresAt);
    console.log(JSON.stringify({ status: "passed", account: config.azure.accountName,
      container: config.containerName, checks: ["client-secret authentication", "private container",
        "blob read/list permission", "user-delegation signing permission"],
      signedDownloadLifetimeSeconds: config.downloadTtlSeconds,
      writesPerformed: 0, databaseConnections: 0, providerCalls: 0 }, null, 2));
  }
} catch (error) {
  // Do not serialize SDK errors: they may contain tokens, request URLs or bodies.
  const statusCode = typeof error?.statusCode === "number" ? error.statusCode : undefined;
  console.error(JSON.stringify({ status: "failed", stage: "azure-connection",
    ...(statusCode ? { statusCode } : {}) }));
  process.exitCode = 1;
}
