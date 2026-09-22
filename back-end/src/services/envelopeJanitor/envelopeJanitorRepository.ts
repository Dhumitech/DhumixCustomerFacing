import type { Pool, QueryResultRow } from "pg";
import { withEnvelopeJanitorTransaction } from "../database/transactions.js";

interface DestroyedEnvelopeCountRow extends QueryResultRow {
  readonly destroyed_count: number;
}

export interface EnvelopeJanitorRepository {
  destroyDue(batchSize: number): Promise<number>;
}

export function createEnvelopeJanitorRepository(pool: Pool): EnvelopeJanitorRepository {
  return {
    async destroyDue(batchSize: number): Promise<number> {
      const result = await withEnvelopeJanitorTransaction(pool, async (database) =>
        database.query<DestroyedEnvelopeCountRow>(
          "SELECT app.destroy_due_response_envelopes($1) AS destroyed_count",
          [batchSize],
        ),
      );

      const destroyedCount = result.rows[0]?.destroyed_count;
      if (
        result.rowCount !== 1 ||
        typeof destroyedCount !== "number" ||
        !Number.isInteger(destroyedCount) ||
        destroyedCount < 0 ||
        destroyedCount > batchSize
      ) {
        throw new Error("Envelope destruction returned an invalid count");
      }

      return destroyedCount;
    },
  };
}
