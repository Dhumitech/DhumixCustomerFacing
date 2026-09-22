import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createEnvelopeJanitorRepository } from "../../src/services/envelopeJanitor/envelopeJanitorRepository.js";

function fakePool(destroyedCount: unknown): {
  readonly pool: Pool;
  readonly query: ReturnType<typeof vi.fn>;
} {
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rows: [], rowCount: 0 })
    .mockResolvedValueOnce({ rows: [], rowCount: 0 })
    .mockResolvedValueOnce({ rows: [{ destroyed_count: destroyedCount }], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [], rowCount: 0 });
  const client = { query, release: vi.fn() };
  return {
    pool: { connect: vi.fn(async () => client) } as unknown as Pool,
    query,
  };
}

describe("createEnvelopeJanitorRepository", () => {
  it("assumes the janitor capability and returns the atomic destruction count", async () => {
    const { pool, query } = fakePool(3);
    const repository = createEnvelopeJanitorRepository(pool);

    await expect(repository.destroyDue(10)).resolves.toBe(3);
    expect(query.mock.calls).toEqual([
      ["BEGIN"],
      ["SET LOCAL ROLE dhumi_envelope_janitor"],
      ["SELECT app.destroy_due_response_envelopes($1) AS destroyed_count", [10]],
      ["COMMIT"],
    ]);
  });

  it("rejects a malformed or impossible database result", async () => {
    const { pool } = fakePool(11);

    await expect(createEnvelopeJanitorRepository(pool).destroyDue(10)).rejects.toThrow(
      "invalid count",
    );
  });
});
