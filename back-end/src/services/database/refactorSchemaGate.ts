import type { Pool } from 'pg';
/** Source activation is a separate step from editing and migration review. */
export async function requireExecutionContraction(pool:Pool,capability:'dhumi_identity'|'dhumi_job_manager'|'dhumi_outbox_dispatcher'='dhumi_identity'):Promise<void> {
  const statements={dhumi_identity:'SET LOCAL ROLE dhumi_identity',dhumi_job_manager:'SET LOCAL ROLE dhumi_job_manager',dhumi_outbox_dispatcher:'SET LOCAL ROLE dhumi_outbox_dispatcher'} as const;
  const database=await pool.connect();
  try {
  await database.query('BEGIN READ ONLY');
  await database.query(statements[capability]);
  const objects=await database.query<{ready:boolean}>(`SELECT to_regclass('app.service_versions') IS NULL AND to_regclass('app.admission_queue_health') IS NOT NULL AND to_regclass('app.organizations') IS NOT NULL AND to_regclass('app.organization_members') IS NOT NULL AS ready`);
  if(objects.rows[0]?.ready!==true)throw new Error('This refactored runtime requires reviewed migration 0075 before activation');
  const result=await database.query<{ready:boolean}>("SELECT EXISTS(SELECT 1 FROM app.schema_migrations WHERE version='0075_naming') AS ready");
  if(result.rows[0]?.ready!==true)throw new Error('Reviewed 0075 migration ledger is required before activation');
  await database.query('COMMIT');
  } catch(error){await database.query('ROLLBACK');throw error;} finally{database.release();}
}

/** Marketplace callers require the matching table contraction before activation. */
export async function requireMarketplaceContraction(pool:Pool,capability:'dhumi_identity'|'dhumi_operator'='dhumi_identity'):Promise<void> {
  const database=await pool.connect();
  try {
    await database.query('BEGIN READ ONLY');
    await database.query(capability==='dhumi_operator'?'SET LOCAL ROLE dhumi_operator':'SET LOCAL ROLE dhumi_identity');
    const result=await database.query<{ready:boolean}>("SELECT to_regclass('app.marketplace_samples') IS NOT NULL AND to_regclass('app.marketplace_sample_downloads') IS NOT NULL AND to_regclass('app.marketplace_sample_deletions') IS NULL AND to_regclass('app.organizations') IS NOT NULL AND EXISTS(SELECT 1 FROM app.schema_migrations WHERE version='0075_naming') AS ready");
    if(result.rows[0]?.ready!==true)throw new Error('Reviewed naming migration 0075 is required before activation');
    await database.query('COMMIT');
  }catch(error){await database.query('ROLLBACK');throw error;}finally{database.release();}
}
