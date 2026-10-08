import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createRedisCapacityLeaseStore } from "../../src/services/jobs/redisCapacityLeaseStore.js";

const enabled = process.env.RUN_REDIS_INTEGRATION_TESTS === "true";
const describeRedis = enabled ? describe : describe.skip;

describeRedis("Redis capacity lease adapter", () => {
  it("acquires, token-checks, renews, releases and reacquires a disposable lease", async () => {
    const store = await createRedisCapacityLeaseStore({
      url: process.env.REDIS_TEST_URL ?? "redis://127.0.0.1:6380",
      keyPrefix: `dhumi:test:${randomUUID()}`,
    });
    const resourceId = randomUUID();
    let finalLease: Awaited<ReturnType<typeof store.acquire>> = null;
    try {
      const first = await store.acquire(resourceId, 5_000);
      expect(first).not.toBeNull();
      await expect(store.acquire(resourceId, 5_000)).resolves.toBeNull();
      const lease = first as NonNullable<typeof first>;
      await expect(store.renew({ ...lease, token: randomUUID() }, 5_000)).resolves.toBe(false);
      await expect(store.release({ ...lease, token: randomUUID() })).resolves.toBe(false);
      await expect(store.renew(lease, 5_000)).resolves.toBe(true);
      await expect(store.release(lease)).resolves.toBe(true);
      finalLease = await store.acquire(resourceId, 5_000);
      expect(finalLease).not.toBeNull();
    } finally {
      if (finalLease) await store.release(finalLease);
      await store.close();
    }
  });
});
