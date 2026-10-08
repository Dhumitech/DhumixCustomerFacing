import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { assert, database, demoEnvironment, sourceEnvironment, liveProviderSettings, verifyTarget, save, runtime } from './common.mjs';
import { getAmazonOperationDefinition } from '../../src/services/brightdata/amazon/amazonOperationDefinitions.ts';
import { AMAZON_PRODUCTS_RESULT_V2 } from '../../src/services/brightdata/amazon/amazonProductsResultV2.ts';
import { templateExecutionDefinitionHash } from '../../src/services/catalogue/templateExecutionDefinition.ts';
import { createBrightDataIntegrationClient } from '../../src/services/brightdata/brightDataIntegrationClient.ts';
import { createLocalProviderReferenceProtector } from '../../src/services/brightdata/providerReferenceProtector.ts';
import { providerDatasetAad } from '../../src/services/brightdata/providerReferenceContexts.ts';

const synthetic = { template: 'de000001-0000-4000-8000-000000000001', version: 'de000001-0000-4000-8000-000000000002', posts: 'de000001-0000-4000-8000-000000000003' };
const configVersion = 'owner-real-demo-amazon-v2';
export async function seed({ publisherId } = {}) {
  assert(demoEnvironment().RUN_EXECUTOR_DRIVER === 'bright_data', 'The interactive demo must use real provider execution');
  const source = sourceEnvironment();
  const keyPath = path.join(runtime, 'real-provider-reference-key.private.txt');
  if (!source.PROVIDER_REFERENCE_LOCAL_KEY && !fs.existsSync(keyPath)) fs.writeFileSync(keyPath, randomBytes(32).toString('base64url'), { mode: 0o600, flag: 'wx' });
  const settings = liveProviderSettings(source);
  const existingReceiptPath = path.join(runtime, 'real-demo-receipt.json');
  const existing = fs.existsSync(existingReceiptPath) ? JSON.parse(fs.readFileSync(existingReceiptPath, 'utf8')) : null;
  const actor = publisherId ?? existing?.publisherId ?? process.env.DHUMI_DEMO_PUBLICATION_USER_ID;
  assert(/^[0-9a-f-]{36}$/.test(actor ?? ''), 'Pass --publisher-id=<existing demo user UUID> for the first owner-authorized real publication');
  const client = createBrightDataIntegrationClient({ requestTimeoutMs: 65000, controlResponseMaxBytes: 65536, catalogueResponseMaxBytes: 16777216, resultMaxBytes: 104857600 });
  const catalogue = await client.listScrapers({ apiKey: settings.BRIGHTDATA_API_KEY, signal: AbortSignal.timeout(70000) });
  const matches = catalogue.filter(x => x.name === 'Amazon products');
  assert(matches.length === 1, 'Real account must expose exactly one Amazon Products scraper; no assumed dataset ID is used');
  const protector = createLocalProviderReferenceProtector('test', settings.PROVIDER_REFERENCE_LOCAL_KEY);
  const operation = getAmazonOperationDefinition('amazon.products.collect_by_url');
  const output = AMAZON_PRODUCTS_RESULT_V2;
  const definition = {
    capability_metadata: { source: 'owner-authorized-real-demo' }, request_schema: operation.inputSchema,
    result_schema: output.outputSchema, error_schema: { type: 'object' }, operation_code: operation.operationCode,
    output_policy: { provider_submission: { endpoint: 'scrape' }, provider_request: { mode: 'collect', limit_per_input: null },
      snapshot: { enabled: true, cancel_enabled: true, multipart_enabled: false, format: 'json' },
      normalizer_code: output.normalizerCode, normalizer_version: output.normalizerVersion, normalized_schema_version: output.schemaVersion },
    commercial_config_version: configVersion, config_version: configVersion,
  };
  const c = database(); await c.connect();
  try {
    await verifyTarget(c);
    assert((await c.query("SELECT id FROM app.users WHERE id=$1 AND state='active'", [actor])).rowCount === 1, 'Publication must be attributed to an existing active demo user');
    await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    try {
      const templates = (await c.query("SELECT id,state,current_public_version_id FROM app.service_templates WHERE slug='amazon-products-collect-by-url' FOR UPDATE")).rows;
      assert(templates.length === 1, 'Use the existing reviewed Amazon Collect by URL Template');
      const template = templates[0];
      const versions = (await c.query("SELECT id,version,published_at,execution_definition,definition_sha256,provider_dataset_ciphertext,provider_dataset_fingerprint FROM app.service_template_versions WHERE service_template_id=$1 ORDER BY version FOR UPDATE", [template.id])).rows;
      let version = versions.find(v => v.execution_definition?.config_version === configVersion);
      if (!version) {
        const acceptedPrevious = versions.find(v => v.id === template.current_public_version_id);
        assert(template.state === 'draft' && template.current_public_version_id === null || template.state === 'published' && acceptedPrevious?.execution_definition?.config_version === 'owner-real-demo-amazon-v1', 'Refusing to replace an unrelated accepted public Amazon version');
        const id = randomUUID(), number = Math.max(...versions.map(v => v.version)) + 1;
        const binding = await protector.protect(matches[0].id, providerDatasetAad(id));
        assert(await protector.reveal(binding.ciphertext, binding.fingerprint, providerDatasetAad(id)) === matches[0].id, 'Protected dataset binding verification failed');
        await c.query(`INSERT INTO app.service_template_versions(id,service_template_id,version,public_name,public_description,input_schema,configuration_schema,presentation_metadata,output_schema,availability_copy,availability_state,engine,execution_definition,definition_sha256,provider_dataset_ciphertext,provider_dataset_fingerprint,published_at,published_by,evidence_ref)
          VALUES($1,$2,$3,$4,'Collect actual Amazon product information using Bright Data. Results are saved privately and can be downloaded.',$5,$6,$7,$8,'Real scraping available','available','amazon.v1',$9,$10,$11,$12,clock_timestamp(),$13,$14)`,
          [id, template.id, number, operation.publicName, operation.inputSchema, operation.configurationSchema,
            { ...operation.presentation, display_priority: 0 }, output.outputSchema, definition, templateExecutionDefinitionHash(definition), binding.ciphertext, binding.fingerprint, actor,
            JSON.stringify({ scope: 'owner-authorized-real-demo', acceptedRun: 'e14de562-1426-40f5-9e70-0877c720b2bc', observedVariantRun: 'c4e46074-3385-4127-b3e5-77a21a7ed7f4', reference: 'real-amazon-variants-output-v2-2026-10-08', providerSubmission: 'scrape-with-snapshot-fallback' })]);
        await c.query("UPDATE app.service_templates SET state='published',current_public_version_id=$2 WHERE id=$1", [template.id, id]);
        await c.query("INSERT INTO app.audit_events(actor_user_id,action,target_type,target_id,outcome,trace_id,safe_diff) VALUES($1,'template.publish','service_template_version',$2,'published',$3,$4)",
          [actor, id, randomUUID(), { scope: 'owner-authorized-real-demo', template_slug: operation.slug, template_version: number }]);
        version = { id, version: number };
      } else {
        assert(template.state === 'published' && template.current_public_version_id === version.id && version.published_at && templateExecutionDefinitionHash(definition).equals(version.definition_sha256), 'Real publication no longer matches the reviewed immutable definition');
        assert(await protector.reveal(version.provider_dataset_ciphertext, version.provider_dataset_fingerprint, providerDatasetAad(version.id)) === matches[0].id, 'Existing real dataset binding/key does not match the account');
      }
      const pending = (await c.query("SELECT id FROM app.runs WHERE template_version_id=$1 AND internal_status IN('QUEUED','SUBMITTED','RESULT_RECEIVED','PROCESSING')", [synthetic.version])).rows;
      assert(pending.length === 0, 'Wait for active synthetic Runs before switching the worker; no accepted Run is silently repinned');
      const retired = await c.query("UPDATE app.service_templates SET state='retired' WHERE id=ANY($1::uuid[]) AND state<>'retired' RETURNING slug", [[synthetic.template, synthetic.posts]]);
      const disabled = await c.query("UPDATE app.services SET state='disabled' WHERE template_version_id=$1 AND state='active' RETURNING id", [synthetic.version]);
      const previousReal = await c.query("UPDATE app.services s SET state='disabled' FROM app.service_template_versions v WHERE s.template_version_id=v.id AND v.service_template_id=$1 AND v.id<>$2 AND v.execution_definition->>'config_version'='owner-real-demo-amazon-v1' AND s.state='active' RETURNING s.id", [template.id, version.id]);
      // This is a global operator change. Do not claim the publisher is a
      // member of every fixture organization or attribute it to another user.
      for (const row of disabled.rows) await c.query("INSERT INTO app.audit_events(actor_user_id,action,target_type,target_id,outcome,trace_id,safe_diff) SELECT $1,'service.synthetic.retired','service',id,'disabled',$2,$3 FROM app.services WHERE id=$4",
        [actor, randomUUID(), { reason: 'owner-requested-real-demo', replacement_template_slug: operation.slug }, row.id]);
      await c.query('COMMIT');
      const receipt = { status: 'PROVISIONED', time: new Date().toISOString(), target: '127.0.0.1:55432/dhumi_test', publisherId: actor,
        templateId: template.id, templateVersionId: version.id, templateVersion: version.version, scraperSlug: operation.slug,
        operationCode: operation.operationCode, providerDriver: 'bright_data', providerSubmission: 'scrape', snapshotFallback: true,
        retiredSyntheticTemplates: retired.rows.map(x => x.slug), disabledSyntheticServices: disabled.rowCount, disabledPreviousRealServices: previousReal.rowCount,
        normalizedSchemaVersion: output.schemaVersion,
        providerSubmissionsDuringProvisioning: 0, immutableHistoryPreserved: true, plaintextProviderIdentifiersLogged: false };
      save('real-demo-receipt.json', receipt);
      console.log('Real Amazon Collect by URL provisioned. Synthetic Templates retired and their Services disabled; history preserved. No scraping submission during provisioning.');
      return receipt;
    } catch (e) { await c.query('ROLLBACK'); throw e; }
  } finally { await c.end(); }
}
