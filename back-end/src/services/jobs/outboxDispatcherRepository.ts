import type { Pool, QueryResultRow } from "pg";
import { withOutboxDispatcherTransaction } from "../database/transactions.js";
import { parseJobCommandEnvelope, type JobCommandEnvelope } from "./jobCommand.js";

interface ClaimedOutboxRow extends QueryResultRow {
  readonly id: string;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly organization_id: string;
  readonly topic: string;
  readonly ordering_key: string;
  readonly payload: unknown;
  readonly schema_version: number;
  readonly claim_token: string;
}

export interface ClaimedJobCommand {
  readonly command: JobCommandEnvelope;
  readonly claimToken: string;
}

export interface OutboxDispatcherRepository {
  claim(input: {
    readonly consumerId: string;
    readonly batchSize: number;
    readonly claimTtlMs: number;
  }): Promise<readonly ClaimedJobCommand[]>;
  markPublished(eventId: string, claimToken: string): Promise<boolean>;
}

export function createOutboxDispatcherRepository(pool: Pool): OutboxDispatcherRepository {
  return {
    async claim(input): Promise<readonly ClaimedJobCommand[]> {
      if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(input.consumerId) || !Number.isInteger(input.batchSize) || input.batchSize<1 || input.batchSize>100 ||
        !Number.isSafeInteger(input.claimTtlMs) || input.claimTtlMs<5000 || input.claimTtlMs>600000) throw new TypeError('Invalid outbox claim');
      const result = await withOutboxDispatcherTransaction(pool, async (database) =>
        database.query<ClaimedOutboxRow>(
          `
            WITH candidates AS (
              SELECT id FROM app.outbox_events WHERE published_at IS NULL AND available_at<=clock_timestamp()
                AND topic IN ('jobs.execute','jobs.cancel','jobs.reconcile','jobs.recover')
                AND (claimed_at IS NULL OR claimed_at<clock_timestamp()-$2::bigint*interval '1 millisecond')
              ORDER BY available_at,created_at,id LIMIT $1 FOR UPDATE SKIP LOCKED
            ) UPDATE app.outbox_events e SET claimed_at=clock_timestamp(),claim_token=gen_random_uuid(),delivery_attempts=delivery_attempts+1
              FROM candidates c WHERE e.id=c.id
              RETURNING e.id,e.aggregate_type,e.aggregate_id,e.organization_id,e.topic,e.ordering_key,e.payload,e.schema_version,e.claim_token
          `,
          [input.batchSize, input.claimTtlMs],
        ),
      );
      return result.rows.map((row) => ({
        command: parseJobCommandEnvelope({
          event_id: row.id,
          topic: row.topic,
          schema_version: row.schema_version,
          aggregate_type: row.aggregate_type,
          aggregate_id: row.aggregate_id,
          tenant_id: row.organization_id,
          ordering_key: row.ordering_key,
          payload: row.payload,
        }),
        claimToken: row.claim_token,
      }));
    },
    async markPublished(eventId, claimToken): Promise<boolean> {
      const result = await withOutboxDispatcherTransaction(pool, async (database) =>
        database.query<{ published: boolean }>(
          "UPDATE app.outbox_events SET published_at=clock_timestamp(),claimed_at=NULL,claim_token=NULL WHERE id=$1 AND claim_token=$2 AND published_at IS NULL RETURNING true AS published",
          [eventId, claimToken],
        ),
      );
      return result.rows[0]?.published === true;
    },
  };
}
