import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Ajv2020Module from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { z } from "zod";
import { loadOperatorConfig } from "../config/operatorEnvironment.js";
import { createOperatorPool } from "../services/database/pools.js";
import { verifyOperatorPool } from "../services/database/roleVerification.js";
import { withOperatorTransaction } from "../services/database/transactions.js";
import { templateExecutionDefinitionHash } from '../services/catalogue/templateExecutionDefinition.js';
import { canonicalJson } from '../helpers/canonicalJson.js';
import { ScraperPackageCommandError, validateScraperContractFile } from "./scraperContract.js";

const metadataSchema = z.object({
  domain_slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  domain_name: z.string().min(1).max(120),
  category: z.string().min(1).max(80),
  icon_key: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  operation_group: z.string().min(1).max(120),
  operation_name: z.string().min(1).max(120),
  display_priority: z.number().int().min(0).max(1_000_000),
}).strict();
const presentationSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,98}[a-z0-9]$/),
  publicName: z.string().trim().min(1).max(160),
  publicDescription: z.string().trim().min(1).max(2000),
  availabilityCopy: z.string().trim().min(1).max(240),
  configurationSchema: z.record(z.string(), z.unknown()),
  metadata: metadataSchema,
}).strict();

function localSchema(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (Array.isArray(value)) return value.every((part) => localSchema(part, depth + 1));
  if (value && typeof value === "object") return Object.entries(value).every(([key, part]) =>
    (key !== "$ref" || (typeof part === "string" && part.startsWith("#"))) && localSchema(part, depth + 1));
  return true;
}

export async function prepareScraperDraft(packagePath: string) {
  const { packet, report, packageSha256 } = await validateScraperContractFile(packagePath);
  if (packet.status !== "reviewed_candidate") {
    throw new ScraperPackageCommandError("Only a reviewed_candidate package can be staged. Fixture-only packages cannot be registered.");
  }
  const evidence = packet.evidence;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence) ||
    (evidence as Record<string, unknown>).kind !== "reviewed_provider_contract" ||
    !/^[a-f0-9]{64}$/.test(String((evidence as Record<string, unknown>).sourceSha256))) {
    throw new ScraperPackageCommandError("Staging requires reviewed provider-contract provenance and its SHA-256.");
  }
  const parsed = presentationSchema.safeParse(packet.presentation);
  if (!parsed.success || !localSchema(parsed.data.configurationSchema) ||
    parsed.data.configurationSchema.type !== "object" ||
    parsed.data.configurationSchema.additionalProperties !== false) {
    throw new ScraperPackageCommandError("Staging requires a valid, strict presentation and local configuration schema.");
  }
  try {
    const Ajv = Ajv2020Module as unknown as new (options: Readonly<Record<string, unknown>>) => {
      compile(schema: object): unknown;
    };
    const compiler = new Ajv({ strict: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
    (addFormatsModule as unknown as (value: object) => void)(compiler);
    compiler.compile(parsed.data.configurationSchema);
  } catch {
    throw new ScraperPackageCommandError("The configuration schema does not compile.");
  }
  const contract = report.outputPolicy.scraper_processing;
  return {
    operationCode: report.operationCode,
    contractHash: report.contractHash,
    packageSha256,
    slug: parsed.data.slug,
    publicName: parsed.data.publicName,
    publicDescription: parsed.data.publicDescription,
    availabilityCopy: parsed.data.availabilityCopy,
    configurationSchema: parsed.data.configurationSchema,
    presentationMetadata: parsed.data.metadata,
    inputSchema: (packet.contract as Record<string, unknown>).inputSchema,
    outputSchema: (packet.contract as Record<string, unknown>).outputSchema,
    processing: contract,
  };
}

function parseOptions(args: readonly string[]) {
  if (args[0] !== "stage") throw new ScraperPackageCommandError(
    "Usage: operator:scraper-onboard -- stage --package <existing.json> --evidence-reference <restricted-reference> --actor <operator> --expected-database <name> --confirm-draft",
  );
  const options: Record<string, string | true> = {};
  for (let index = 1; index < args.length; index++) {
    const key = args[index];
    if (!key || !key.startsWith("--") || Object.hasOwn(options, key)) throw new ScraperPackageCommandError("Invalid onboarding options.");
    if (key === "--confirm-draft") { options[key] = true; continue; }
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new ScraperPackageCommandError("Invalid onboarding options.");
    options[key] = value;
  }
  const allowed = ["--package", "--evidence-reference", "--actor", "--expected-database", "--confirm-draft"];
  if (Object.keys(options).some((key) => !allowed.includes(key)) || options["--confirm-draft"] !== true ||
    typeof options["--package"] !== "string" || typeof options["--evidence-reference"] !== "string" ||
    typeof options["--actor"] !== "string" || typeof options["--expected-database"] !== "string") {
    throw new ScraperPackageCommandError("Missing or invalid onboarding options. Use stage with a real reviewed package and --confirm-draft.");
  }
  return {
    packagePath: options["--package"], evidenceReference: options["--evidence-reference"],
    actor: options["--actor"], expectedDatabase: options["--expected-database"],
  };
}

/** Stages a private draft only. This command has no provider or publication imports. */
export async function runScraperOnboardCommand(args: readonly string[] = process.argv.slice(2)) {
  const options = parseOptions(args);
  const draft = await prepareScraperDraft(options.packagePath);
  const config = loadOperatorConfig();
  if (config.database.database !== options.expectedDatabase) {
    throw new ScraperPackageCommandError("Expected database does not match the configured operator database.");
  }
  const pool = createOperatorPool(config.database, () => undefined, "dhumi-scraper-onboard");
  try {
    await verifyOperatorPool(pool, config.database.credential.user);
    const result = await withOperatorTransaction(pool, async (database) => {
      const identity = await database.query<{ database_name: string }>("SELECT current_database() AS database_name");
      if (identity.rows[0]?.database_name !== options.expectedDatabase) {
        throw new ScraperPackageCommandError("Connected database does not match --expected-database.");
      }
      const definition={capability_metadata:{source:'reviewed_scraper_contract',package_sha256:draft.packageSha256},
        request_schema:draft.inputSchema as Record<string,unknown>,result_schema:draft.outputSchema as Record<string,unknown>,error_schema:{},
        operation_code:draft.operationCode,output_policy:{scraper_processing:draft.processing,scraper_contract_sha256:draft.contractHash},
        commercial_config_version:'unqualified',config_version:'draft:'+draft.packageSha256};
      await database.query("SELECT pg_advisory_xact_lock(hashtextextended('template-stage:'||$1,0))",[draft.slug]);
      const existing=await database.query<{id:string;state:string;version_id:string|null;execution_definition:unknown}>(`SELECT t.id,t.state,v.id version_id,v.execution_definition
        FROM app.service_templates t LEFT JOIN app.service_template_versions v ON v.service_template_id=t.id AND v.version=1 WHERE t.slug=$1 FOR UPDATE OF t`,[draft.slug]);
      const found=existing.rows[0];
      if(found){if(found.state!=='draft'||!found.version_id||canonicalJson(found.execution_definition)!==canonicalJson(definition))throw new ScraperPackageCommandError('Draft identity conflicts with the stored version.');
        return {template_id:found.id,template_version_id:found.version_id,disposition:'replayed' as const};}
      const template=await database.query<{id:string}>("INSERT INTO app.service_templates(slug,product_family,state) VALUES($1,'scraper_library','draft') RETURNING id",[draft.slug]);
      const templateId=template.rows[0]?.id;if(!templateId)throw new ScraperPackageCommandError('Draft parent could not be stored.');
      const version=await database.query<{id:string}>(`INSERT INTO app.service_template_versions(service_template_id,version,public_name,public_description,input_schema,output_schema,
        availability_copy,availability_state,configuration_schema,presentation_metadata,engine,execution_definition,definition_sha256)
        VALUES($1,1,$2,$3,$4,$5,$6,'coming_soon',$7,$8,'scraper.v1',$9,$10) RETURNING id`,
        [templateId,draft.publicName,draft.publicDescription,draft.inputSchema,draft.outputSchema,draft.availabilityCopy,draft.configurationSchema,draft.presentationMetadata,definition,templateExecutionDefinitionHash(definition)]);
      const versionId=version.rows[0]?.id;if(!versionId)throw new ScraperPackageCommandError('Draft version could not be stored.');
      await database.query(`INSERT INTO app.audit_events(action,target_type,target_id,outcome,safe_diff) VALUES('scraper.operation.stage','service_template_version',$1,'created',
        jsonb_build_object('operator',$2::text,'restricted_evidence_reference',$3::text,'package_sha256',$4::text))`,[versionId,options.actor,options.evidenceReference,draft.packageSha256]);
      return {template_id:templateId,template_version_id:versionId,disposition:'created' as const};
    });
    return {
      operationCode: draft.operationCode, slug: draft.slug,
      templateId: result.template_id, templateVersionId: result.template_version_id,
      contractHash: draft.contractHash, disposition: result.disposition,
      state: "private_draft_not_qualified_not_published",
      providerCalls: 0, customerPublication: false,
    };
  } finally { await pool.end(); }
}

const invokedPath = process.argv[1];
if (invokedPath && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  runScraperOnboardCommand().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error: unknown) => {
      const message = error instanceof ScraperPackageCommandError ? error.message :
        "Draft registration failed. Confirm migration 0073 and the reviewed package; no provider call was made.";
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
}
