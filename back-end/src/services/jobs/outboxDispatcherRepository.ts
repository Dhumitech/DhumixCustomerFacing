import type { Pool, QueryResultRow } from "pg";
import { withOutboxDispatcherTransaction } from "../database/transactions.js";
import { parseJobCommandEnvelope, type JobCommandEnvelope } from "./jobCommand.js";

interface ClaimedOutboxRow extends QueryResultRow {
  readonly id: string;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly tenant_id: string;
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
      const result = await withOutboxDispatcherTransaction(pool, async (database) =>
        database.query<ClaimedOutboxRow>(
          `
            SELECT *
            FROM app.claim_job_outbox_events(
              $1,
              $2,
              $3::bigint * interval '1 millisecond'
            )
          `,
          [input.consumerId, input.batchSize, input.claimTtlMs],
        ),
      );
      return result.rows.map((row) => ({
        command: parseJobCommandEnvelope({
          event_id: row.id,
          topic: row.topic,
          schema_version: row.schema_version,
          aggregate_type: row.aggregate_type,
          aggregate_id: row.aggregate_id,
          tenant_id: row.tenant_id,
          ordering_key: row.ordering_key,
          payload: row.payload,
        }),
        claimToken: row.claim_token,
      }));
    },
    async markPublished(eventId, claimToken): Promise<boolean> {
      const result = await withOutboxDispatcherTransaction(pool, async (database) =>
        database.query<{ published: boolean }>(
          "SELECT app.mark_outbox_event_published($1, $2) AS published",
          [eventId, claimToken],
        ),
      );
      return result.rows[0]?.published === true;
    },
  };
}
