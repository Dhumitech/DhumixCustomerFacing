import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Pool } from 'pg';
import { withJobManagerTenantTransaction } from '../database/transactions.js';
import { appendRunEvent, lockLifecycleRun, requireLiveAttempt, recordNormalizedUsage, runDatabaseError } from './runLifecycle.js';
import { createRunExecutionRepository } from './runExecutionRepository.js';
import type { ResultObjectStore } from '../storage/resultObjectStore.js';
import type { ResultIngestionService } from '../storage/resultIngestionService.js';
import { AMAZON_PRODUCTS_RESULT_V2, normalizeAmazonProductsResultV2 } from '../brightdata/amazon/amazonProductsResultV2.js';

/** Explicit operator recovery of a failed local normalization. It has no provider
 * transport, secret resolver or submission/outbox dependency. Original admission,
 * provider Attempt/calls/raw bytes and failure events remain unchanged.
 * The new schema is an explicit, recorded recovery revision, never a silent
 * replacement of an immutable published Template or historical normalizer.
 */
export async function reprocessStoredAmazonProducts(dependencies: {
  readonly jobPool: Pool; readonly store: ResultObjectStore; readonly ingestion: ResultIngestionService; readonly maxBytes: number;
}, input: { readonly organizationId: string; readonly runId: string }) {
  if (![input.organizationId, input.runId].every(id => /^[0-9a-f-]{36}$/.test(id))) throw new Error('Explicit Run and organization are required');
  const tx = <T>(work: Parameters<typeof withJobManagerTenantTransaction<T>>[2]) => withJobManagerTenantTransaction(dependencies.jobPool, input.organizationId, work);
  const eventKey = 'operator.product-normalization-v2:' + input.runId;
  const claim = await tx(async db => {
    const run = await lockLifecycleRun(db, input.organizationId, input.runId);
    const existing = await db.query<{ safe_payload: { artifact_id: string; record_count: number } }>(
      'SELECT safe_payload FROM app.run_events WHERE organization_id=$1 AND run_id=$2 AND event_idempotency_key=$3', [input.organizationId, input.runId, eventKey]);
    if (existing.rows[0] && run.internal_status === 'COMPLETED') return { replay: true as const, ...existing.rows[0].safe_payload };
    if (run.internal_status !== 'PROCESSING_FAILED') runDatabaseError('23514', 'ONLY_FAILED_STORED_PRODUCT_NORMALIZATION_CAN_BE_REPROCESSED');
    const raw = await db.query<{ id: string; attempt_id: string; artifact_version: number; byte_count: string; checksum: Buffer; schema: string }>(`
      SELECT a.id,a.attempt_id,a.artifact_version,a.byte_count::text,a.checksum,
        v.execution_definition->'output_policy'->>'normalized_schema_version' AS schema
      FROM app.artifacts a JOIN app.run_attempts p ON p.organization_id=a.organization_id AND p.run_id=a.run_id AND p.id=a.attempt_id
      JOIN app.service_template_versions v ON v.id=$3
      WHERE a.organization_id=$1 AND a.run_id=$2 AND a.kind='raw' AND a.state='durable'
        AND p.kind='submission' AND p.state='failed' AND p.outcome_class='provider_response_invalid'
        AND v.execution_definition->>'operation_code'='amazon.products.collect_by_url'
      ORDER BY a.artifact_version DESC LIMIT 1`, [input.organizationId, input.runId, run.template_version_id]);
    const source = raw.rows[0];
    if (!source || Number(source.byte_count) < 1 || Number(source.byte_count) > dependencies.maxBytes) runDatabaseError('23514', 'DURABLE_FAILED_PRODUCT_RAW_REQUIRED');
    const busy = await db.query("SELECT id FROM app.run_attempts WHERE organization_id=$1 AND run_id=$2 AND state='claimed' AND worker_lease_expires_at>clock_timestamp()", [input.organizationId, input.runId]);
    if (busy.rowCount) runDatabaseError('40001', 'RUN_ATTEMPT_STILL_ACTIVE');
    const attempt = await db.query<{ id: string; fence_token: string }>(`
      INSERT INTO app.run_attempts(organization_id,run_id,attempt_number,kind,state,worker_lease_expires_at)
      VALUES($1,$2,(SELECT coalesce(max(attempt_number),0)+1 FROM app.run_attempts WHERE organization_id=$1 AND run_id=$2 AND kind='reconciliation'),
        'reconciliation','claimed',clock_timestamp()+interval '120 seconds') RETURNING id,fence_token`, [input.organizationId, input.runId]);
    if (!attempt.rows[0]) throw new Error('Recovery Attempt was not created');
    await appendRunEvent(db, { tenantId: input.organizationId, runId: input.runId, eventType: 'normalization_reprocessing_started',
      eventIdempotencyKey: 'operator.normalization-started:' + attempt.rows[0].id,
      safePayload: { source_attempt_id: source.attempt_id, recovery_attempt_id: attempt.rows[0].id, previous_schema_version: source.schema, schema_version: AMAZON_PRODUCTS_RESULT_V2.schemaVersion, provider_submission: false } });
    return { replay: false as const, source, attempt: attempt.rows[0], stateVersion: Number(run.state_version) };
  });
  if (claim.replay) return { runId: input.runId, artifactId: claim.artifact_id, recordCount: claim.record_count, replay: true, providerSubmissions: 0 };
  try {
    const raw = await dependencies.store.open({ tenantId: input.organizationId, runId: input.runId, attemptId: claim.source.attempt_id,
      kind: 'raw', artifactVersion: claim.source.artifact_version }, dependencies.maxBytes);
    const checksum = createHash('sha256'); let byteCount = 0;
    const verifiedBytes = Readable.from((async function* () { for await (const chunk of raw.bytes) { const bytes = Buffer.from(chunk); checksum.update(bytes); byteCount += bytes.length; yield bytes; } })());
    const normalized = await normalizeAmazonProductsResultV2({ bytes: verifiedBytes, contentType: raw.receipt.contentType,
      contentEncoding: raw.receipt.contentEncoding, maxBytes: dependencies.maxBytes });
    if (byteCount !== Number(claim.source.byte_count) || !checksum.digest().equals(claim.source.checksum)) throw new Error('Stored raw integrity verification failed');
    const result = await dependencies.ingestion.ingest({ identity: { tenantId: input.organizationId, runId: input.runId,
      attemptId: claim.attempt.id, kind: 'normalized', artifactVersion: 2 }, bytes: Readable.from([normalized.bytes]), contentType: normalized.contentType,
      contentEncoding: normalized.contentEncoding, schemaVersion: normalized.schemaVersion, recordCount: normalized.recordCount, expiresAt: null });
    await tx(async db => {
      const run = await lockLifecycleRun(db, input.organizationId, input.runId);
      await requireLiveAttempt(db, { tenantId: input.organizationId, runId: input.runId, attemptId: claim.attempt.id, fenceToken: claim.attempt.fence_token });
      if (run.internal_status !== 'PROCESSING_FAILED' || Number(run.state_version) !== claim.stateVersion) runDatabaseError('40001', 'NORMALIZATION_RECOVERY_STATE_CONFLICT');
      await recordNormalizedUsage(db, { tenantId: input.organizationId, runId: input.runId, sourceAttemptId: claim.attempt.id,
        normalizedArtifactId: result.artifactId, usage: { meterCode: 'amazon.result_records.observed', unit: 'records' } });
      const updated = await db.query(`UPDATE app.runs SET internal_status='COMPLETED',state_version=state_version+1,customer_error_code=NULL,
        retryable=false,completed_at=clock_timestamp() WHERE organization_id=$1 AND id=$2 AND internal_status='PROCESSING_FAILED' AND state_version=$3 RETURNING id`,
        [input.organizationId, input.runId, claim.stateVersion]);
      if (updated.rowCount !== 1) runDatabaseError('40001', 'NORMALIZATION_RECOVERY_STATE_CONFLICT');
      await appendRunEvent(db, { tenantId: input.organizationId, runId: input.runId, eventType: 'processing_recovered', eventIdempotencyKey: eventKey,
        safePayload: { status: 'ready', artifact_id: result.artifactId, record_count: normalized.recordCount, source_attempt_id: claim.source.attempt_id,
          recovery_attempt_id: claim.attempt.id, previous_schema_version: claim.source.schema, schema_version: normalized.schemaVersion, provider_submission: false } });
      await appendRunEvent(db, { tenantId: input.organizationId, runId: input.runId, eventType: 'completed', eventIdempotencyKey: eventKey + ':completed', safePayload: { status: 'ready' } });
      const finished = await db.query("UPDATE app.run_attempts SET state='completed',outcome_class='normalization_reprocessed_v2',worker_lease_expires_at=NULL,finished_at=clock_timestamp() WHERE organization_id=$1 AND id=$2 AND state='claimed' AND fence_token=$3 RETURNING id",
        [input.organizationId, claim.attempt.id, claim.attempt.fence_token]);
      if (finished.rowCount !== 1) runDatabaseError('40001', 'NORMALIZATION_RECOVERY_FENCE_REJECTED');
    });
    return { runId: input.runId, artifactId: result.artifactId, recordCount: normalized.recordCount, replay: false, providerSubmissions: 0 };
  } catch (error) {
    await createRunExecutionRepository(dependencies.jobPool).finish({ tenantId: input.organizationId, attemptId: claim.attempt.id,
      fenceToken: claim.attempt.fence_token, state: 'failed', outcomeClass: 'normalization_reprocess_failed' }).catch(() => {});
    throw error;
  }
}
