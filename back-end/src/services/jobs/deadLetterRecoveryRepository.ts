import { randomUUID } from 'node:crypto';
import type { Pool } from "pg";
import { withOperatorTransaction } from "../database/transactions.js";
import { lockLifecycleRun,runDatabaseError,TERMINAL_RUN_STATES } from './runLifecycle.js';

export type DeadLetterRecoveryReason =
  | "transient_infrastructure_recovered"
  | "configuration_repaired"
  | "manual_reconciliation_required";

export interface DeadLetterRecoveryRecord {
  readonly recoveryEventId: string | null;
  readonly scheduled: boolean;
  readonly terminal: boolean;
}

export interface DeadLetterRecoveryRepository {
  requestRecovery(input: {
    readonly originalEventId: string;
    readonly reasonCode: DeadLetterRecoveryReason;
  }): Promise<DeadLetterRecoveryRecord>;
}

export function createDeadLetterRecoveryRepository(pool: Pool): DeadLetterRecoveryRepository {
  return {
    async requestRecovery(input): Promise<DeadLetterRecoveryRecord> {
      return withOperatorTransaction(pool,async db=>{
        if(!['transient_infrastructure_recovered','configuration_repaired','manual_reconciliation_required'].includes(input.reasonCode))runDatabaseError('22023','DEAD_LETTER_RECOVERY_REASON_INVALID');
        const original=await db.query<{organization_id:string;aggregate_id:string}>(`SELECT organization_id,aggregate_id FROM app.outbox_events
          WHERE id=$1 AND topic IN ('jobs.execute','jobs.cancel','jobs.reconcile','jobs.recover') AND organization_id IS NOT NULL AND published_at IS NOT NULL`,[input.originalEventId]);
        const event=original.rows[0];if(!event)runDatabaseError('P0002','DEAD_LETTER_COMMAND_NOT_AUTHORITATIVE');
        await db.query("SELECT set_config('app.organization_id',$1,true)",[event.organization_id]);
        const run=await lockLifecycleRun(db,event.organization_id,event.aggregate_id);
        await db.query('SELECT id FROM app.outbox_events WHERE id=$1 FOR UPDATE',[input.originalEventId]);
        if(TERMINAL_RUN_STATES.includes(run.internal_status as typeof TERMINAL_RUN_STATES[number]))return {recoveryEventId:null,scheduled:false,terminal:true};
        const traceId=randomUUID();
        const saved=await db.query<{id:string}>(`INSERT INTO app.outbox_events (aggregate_type,aggregate_id,organization_id,topic,ordering_key,payload,schema_version,recovered_from_event_id)
          VALUES ('run',$1::uuid,$2::uuid,'jobs.recover',$1::uuid::text,jsonb_build_object('run_id',$1::uuid::text,'trace_id',$4::uuid)||coalesce((
            SELECT jsonb_build_object('initiated_by_user_id',safe_payload->>'initiated_by_user_id') FROM app.run_events
            WHERE organization_id=$2::uuid AND run_id=$1::uuid AND event_type='cancellation_requested' AND safe_payload ? 'initiated_by_user_id' ORDER BY sequence LIMIT 1),'{}'::jsonb),1,$3)
          ON CONFLICT (recovered_from_event_id) DO NOTHING RETURNING id`,[run.id,event.organization_id,input.originalEventId,traceId]);
        let id=saved.rows[0]?.id;
        if(id)await db.query(`INSERT INTO app.audit_events (organization_id,action,target_type,target_id,outcome,trace_id,safe_diff)
          VALUES ($1,'run.dead_letter_recover','outbox_event',$2,'scheduled',$3,jsonb_build_object('reason',$4::text))`,[event.organization_id,id,traceId,input.reasonCode]);
        else id=(await db.query<{id:string}>('SELECT id FROM app.outbox_events WHERE recovered_from_event_id=$1',[input.originalEventId])).rows[0]?.id;
        if(!id)runDatabaseError('23514','DEAD_LETTER_RECOVERY_NOT_FOUND');
        return {recoveryEventId:id,scheduled:saved.rows.length===1,terminal:false};
      });
    },
  };
}
