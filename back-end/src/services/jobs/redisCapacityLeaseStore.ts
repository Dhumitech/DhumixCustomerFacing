import { randomUUID } from "node:crypto";
import { createClient, type RedisClientType } from "redis";
import type { CapacityLease, CapacityLeaseStore } from "./capacityLease.js";
import { redisConnectionKind } from "../../config/redisEnvironment.js";

const RESOURCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const RENEW_SCRIPT = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('PEXPIRE', KEYS[1], ARGV[2])
  end
  return 0
`;

const RELEASE_SCRIPT = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
  return 0
`;

function requireTtl(ttlMs: number): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 5_000 || ttlMs > 300_000) {
    throw new TypeError("ttlMs must be between 5000 and 300000 milliseconds");
  }
}

export async function createRedisCapacityLeaseStore(input: {
  readonly url: string;
  readonly keyPrefix: string;
  readonly onError?: (error: Error) => void;
}): Promise<CapacityLeaseStore> {
  const secure = redisConnectionKind(input.url) === "azure";
  const client: RedisClientType = createClient({
    url: input.url,
    disableOfflineQueue: true,
    socket: {
      ...(secure ? { tls: true as const, minVersion: "TLSv1.2" as const, rejectUnauthorized: true } : {}),
      connectTimeout: 5_000,
      reconnectStrategy(retries) {
        if (retries >= 5) return false;
        return Math.min(100 * 2 ** retries, 1_000);
      },
    },
  });
  client.on("error", (error) => input.onError?.(error));
  try { await client.connect(); } catch (error) { if (client.isOpen) client.destroy(); throw error; }
  const keyFor = (resourceId: string): string => `${input.keyPrefix}:${resourceId.toLowerCase()}`;

  return {
    async acquire(resourceId, ttlMs): Promise<CapacityLease | null> {
      if (!RESOURCE_ID.test(resourceId)) throw new TypeError("resourceId must be a UUID");
      requireTtl(ttlMs);
      const token = randomUUID();
      const result = await client.set(keyFor(resourceId), token, { NX: true, PX: ttlMs });
      return result === "OK" ? { resourceId: resourceId.toLowerCase(), token } : null;
    },
    async renew(lease, ttlMs): Promise<boolean> {
      requireTtl(ttlMs);
      const result = await client.eval(RENEW_SCRIPT, {
        keys: [keyFor(lease.resourceId)],
        arguments: [lease.token, String(ttlMs)],
      });
      return result === 1;
    },
    async release(lease): Promise<boolean> {
      const result = await client.eval(RELEASE_SCRIPT, {
        keys: [keyFor(lease.resourceId)],
        arguments: [lease.token],
      });
      return result === 1;
    },
    async close(): Promise<void> {
      if (!client.isOpen) return;
      if (client.isReady) {
        await client.quit();
      } else {
        client.destroy();
      }
    },
  };
}
