import type { Pool, QueryResultRow } from "pg";
import { withOperatorTransaction } from "../database/transactions.js";

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

interface RecoveryRow extends QueryResultRow {
  readonly recovery_event_id: string | null;
  readonly scheduled: boolean;
  readonly terminal: boolean;
}

export function createDeadLetterRecoveryRepository(pool: Pool): DeadLetterRecoveryRepository {
  return {
    async requestRecovery(input): Promise<DeadLetterRecoveryRecord> {
      const result = await withOperatorTransaction(pool, async (database) =>
        database.query<RecoveryRow>(
          "SELECT * FROM app.recover_dead_lettered_run_command($1, $2)",
          [input.originalEventId, input.reasonCode],
        ),
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error("Dead-letter recovery returned no result");
      return {
        recoveryEventId: row.recovery_event_id,
        scheduled: row.scheduled,
        terminal: row.terminal,
      };
    },
  };
}
