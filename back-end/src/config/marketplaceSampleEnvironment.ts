import { z } from "zod";
import { ConfigurationError } from "./environment.js";
import { loadOperatorConfig, type OperatorRuntimeConfig } from "./operatorEnvironment.js";

const storageSchema = z.object({
  RESULT_STORAGE_DRIVER: z.literal("azurite"),
  RESULT_STORAGE_CONNECTION_STRING: z.string().trim().min(1),
  RESULT_STORAGE_CONTAINER: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/),
  RESULT_MAX_BYTES: z.coerce.number().int().positive(),
});

export interface MarketplaceSampleRuntimeConfig extends OperatorRuntimeConfig {
  readonly storage: Readonly<{
    connectionString: string;
    containerName: string;
    maxBytes: number;
  }>;
}

/** The retained fixture commands need operator SQL and private storage only. */
export function loadMarketplaceSampleConfig(
  source: NodeJS.ProcessEnv = process.env,
): MarketplaceSampleRuntimeConfig {
  const operator = loadOperatorConfig(source);
  const parsed = storageSchema.safeParse(source);
  if (!parsed.success) {
    const issues = [...new Set(parsed.error.issues.map((issue) =>
      `${issue.path.join(".") || "environment"} (${issue.message})`,
    ))].sort();
    throw new ConfigurationError(`Invalid Marketplace sample environment: ${issues.join(", ")}`);
  }
  return Object.freeze({
    ...operator,
    storage: Object.freeze({
      connectionString: parsed.data.RESULT_STORAGE_CONNECTION_STRING,
      containerName: parsed.data.RESULT_STORAGE_CONTAINER,
      maxBytes: parsed.data.RESULT_MAX_BYTES,
    }),
  });
}
