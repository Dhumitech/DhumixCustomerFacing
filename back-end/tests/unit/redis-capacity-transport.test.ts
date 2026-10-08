import { describe, expect, it, vi } from "vitest";
import { createClient } from "redis";
import { createRedisCapacityLeaseStore } from "../../src/services/jobs/redisCapacityLeaseStore.js";
const mock = vi.hoisted(() => ({ on: vi.fn(), connect: vi.fn(), destroy: vi.fn(), quit: vi.fn(), isOpen: true, isReady: true }));
vi.mock("redis", () => ({ createClient: vi.fn(() => mock) }));
const url = "rediss://:" + "fake-test-secret-".repeat(4) + "@redis-example.centralindia.redis.azure.net:10000";
describe("Redis capacity transport security", () => {
  it("uses verified TLS 1.2 or later without buffering commands while disconnected", async () => {
    mock.connect.mockResolvedValue(undefined);
    const store = await createRedisCapacityLeaseStore({ url, keyPrefix: "dhumi:test" });
    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({ url, disableOfflineQueue: true,
      socket: expect.objectContaining({ tls: true, minVersion: "TLSv1.2", rejectUnauthorized: true, connectTimeout: 5000 }) }));
    await store.close();
  });
  it("closes a failed connection instead of leaving reconnect work behind", async () => {
    mock.connect.mockRejectedValueOnce(new Error("test authentication failure"));
    await expect(createRedisCapacityLeaseStore({ url, keyPrefix: "dhumi:test" })).rejects.toThrow(/authentication failure/);
    expect(mock.destroy).toHaveBeenCalledOnce();
  });
});
