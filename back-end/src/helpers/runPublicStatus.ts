/** One accepted public projection of the existing internal lifecycle. */
export const RUN_PUBLIC_STATUS_SQL = `CASE
  WHEN run.internal_status = 'QUEUED' THEN 'queued'
  WHEN run.internal_status IN ('SUBMITTED','RESULT_RECEIVED','PROCESSING') THEN 'running'
  WHEN run.internal_status = 'COMPLETED' THEN 'ready'
  WHEN run.internal_status = 'CANCELLED' THEN 'cancelled'
  WHEN run.internal_status = 'EXPIRED' THEN 'expired'
  ELSE 'failed' END`;

export function runPublicStatus(status: string): string {
  if (status === 'QUEUED') return 'queued';
  if (['SUBMITTED','RESULT_RECEIVED','PROCESSING'].includes(status)) return 'running';
  if (status === 'COMPLETED') return 'ready';
  if (status === 'CANCELLED') return 'cancelled';
  if (status === 'EXPIRED') return 'expired';
  return 'failed';
}
