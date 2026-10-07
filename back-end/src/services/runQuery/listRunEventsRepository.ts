import type { Pool } from "pg";
import { ApplicationError } from "../../utils/applicationError.js";
import { withOrganizationReadTransaction } from "../database/transactions.js";

export interface ListRunEventsRecord {
  readonly id: string;
  readonly sequence: string;
  readonly eventType: string;
  readonly occurredAt: Date;
}

export interface ListRunEventsRepositoryInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly runId: string;
  readonly afterSequence: string | undefined;
  readonly fetchLimit: number;
}

export interface ListRunEventsRepository {
  findPage(
    input: ListRunEventsRepositoryInput,
  ): Promise<readonly ListRunEventsRecord[] | undefined>;
}

interface RunExistsRow {
  readonly id: string;
}

interface RunEventRow {
  readonly id: string;
  readonly sequence: string;
  readonly event_type: string;
  readonly occurred_at: Date;
}

function internalFailure(cause: unknown): ApplicationError {
  return new ApplicationError({
    status: 500,
    code: "INTERNAL_ERROR",
    title: "Internal server error",
    cause,
  });
}

export function createListRunEventsRepository(pool: Pool): ListRunEventsRepository {
  return {
    async findPage(input): Promise<readonly ListRunEventsRecord[] | undefined> {
      if (!Number.isInteger(input.fetchLimit) || input.fetchLimit < 2 || input.fetchLimit > 101) {
        throw new TypeError("fetchLimit must be an integer between 2 and 101");
      }

      try {
        return await withOrganizationReadTransaction(
          pool,
          { tenantId: input.tenantId, userId: input.userId },
          async (database) => {
            const run = await database.query<RunExistsRow>(
              `
                SELECT run.id
                FROM app.runs AS run
                WHERE run.organization_id = $1
                  AND run.id = $2::uuid
                LIMIT 1
              `,
              [input.tenantId, input.runId],
            );
            if (run.rows[0] === undefined) return undefined;

            const events = await database.query<RunEventRow>(
              `
                SELECT
                  event.id,
                  event.sequence::text AS sequence,
                  event.event_type,
                  event.occurred_at
                FROM app.run_events AS event
                WHERE event.organization_id = $1
                  AND event.run_id = $2::uuid
                  AND event.sequence > COALESCE($3::bigint, 0::bigint)
                ORDER BY event.sequence ASC
                LIMIT $4::integer
              `,
              [input.tenantId, input.runId, input.afterSequence ?? null, input.fetchLimit],
            );

            return events.rows.map((row) => ({
              id: row.id,
              sequence: row.sequence,
              eventType: row.event_type,
              occurredAt: row.occurred_at,
            }));
          },
        );
      } catch (error) {
        if (error instanceof ApplicationError) throw error;
        throw internalFailure(error);
      }
    },
  };
}
