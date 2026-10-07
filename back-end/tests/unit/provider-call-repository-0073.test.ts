import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createProviderCallRecorder, ProviderCallRecordingError } from "../../src/services/brightdata/providerCallRepository.js";

const fence = { tenantId: randomUUID(), runId: randomUUID(), attemptId: randomUUID(), fenceToken: randomUUID() };
const starter = randomUUID(), cancelRequester = randomUUID();
function pool(options: { disabled?: boolean; lostFence?: boolean; duplicate?: boolean; noObservation?: boolean; historical?: boolean; unknown?: boolean } = {}) {
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    if (sql.includes("set_config")) return { rows: [{ organization_id: values[0] }] };
    if (sql.includes("FOR UPDATE OF r")) return { rows: [{ created_by_user_id: options.unknown ? null : starter, service_id: randomUUID(), service_state: options.disabled ? "disabled" : "active",execution_allowed:!options.disabled }] };
    if (sql.includes("worker_lease_expires_at")) return { rows: options.lostFence ? [] : [{ id: fence.attemptId }] };
    if (sql.includes("purpose='run_submit'")) return { rows: options.duplicate ? [{ id: randomUUID() }] : [] };
    if (sql.includes("FROM app.run_events")) return { rows: [{ initiated_by_user_id: options.historical || options.unknown ? null : cancelRequester }] };
    if (sql.includes("FROM app.audit_events")) return { rows: [{ actor_user_id: options.unknown ? null : cancelRequester }] };
    if (sql.includes("INSERT INTO app.provider_calls")) return { rows: [{ id: values[0] }] };
    if (sql.includes("UPDATE app.provider_calls")) return { rows: options.noObservation ? [] : [{ id: values[4] }] };
    return { rows: [] };
  });
  const release = vi.fn();
  return { instance: { connect: vi.fn(async () => ({ query, release })) } as unknown as Pool, query, release };
}

describe("fenced provider-call repository for matching 0073", () => {
  it("commits durable submission evidence with Run starter before returning the call ID", async () => {
    const fake = pool(), recorder = createProviderCallRecorder(fake.instance, fence);
    const id = await recorder.prepare("run_submit", "/datasets/v3/scrape");
    const insert = fake.query.mock.calls.find(([sql]) => sql.includes("INSERT INTO app.provider_calls"))!;
    expect(insert[1]).toEqual([id, fence.tenantId, fence.runId, starter, fence.attemptId, "run_submit", "/datasets/v3/scrape"]);
    expect(fake.query.mock.calls.at(-1)?.[0]).toBe("COMMIT"); expect(fake.release).toHaveBeenCalledOnce();
  });
  it.each([{ disabled: true }, { lostFence: true }, { duplicate: true }])("refuses submission and rolls back for %j", async options => {
    const fake = pool(options);
    await expect(createProviderCallRecorder(fake.instance, fence).prepare("run_submit", "/datasets/v3/trigger")).rejects.toBeInstanceOf(ProviderCallRecordingError);
    expect(fake.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO app.provider_calls"))).toBe(false);
    expect(fake.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });
  it.each([false, true])("attributes cancellation to the first accepted requester (historical=%s)", async historical => {
    const fake = pool({ historical });
    await createProviderCallRecorder(fake.instance, fence).prepare("run_cancel", "/datasets/v3/snapshot/:snapshot/cancel");
    expect(fake.query.mock.calls.find(([sql]) => sql.includes("INSERT INTO app.provider_calls"))?.[1]?.[3]).toBe(cancelRequester);
  });
  it("keeps unmatched historical initiators unknown", async () => {
    const fake = pool({ unknown: true });
    await createProviderCallRecorder(fake.instance, fence).prepare("run_cancel", "/datasets/v3/snapshot/:snapshot/cancel");
    expect(fake.query.mock.calls.find(([sql]) => sql.includes("INSERT INTO app.provider_calls"))?.[1]?.[3]).toBeNull();
  });
  it.each(["/datasets/v3/snapshot/s_private", "/datasets/v3/scrape?dataset_id=gd_private", "/datasets/v3/progress/:snapshot"])("refuses unredacted or mismatched submit endpoint %s before SQL", async endpoint => {
    const fake = pool();
    await expect(createProviderCallRecorder(fake.instance, fence).prepare("run_submit", endpoint)).rejects.toBeInstanceOf(ProviderCallRecordingError);
    expect(fake.query).not.toHaveBeenCalled();
  });
  it("stores unknown complete-body size as NULL and guards exact call/attempt/fence on finalization", async () => {
    const fake = pool(), id = randomUUID();
    await createProviderCallRecorder(fake.instance, fence).finish(id, { state: "responded", httpStatus: 200, responseBytes: null, safeErrorCode: null });
    const update = fake.query.mock.calls.find(([sql]) => sql.includes("UPDATE app.provider_calls"))!;
    expect(update[1]).toEqual(["responded", 200, null, null, id, fence.tenantId, fence.runId, fence.attemptId, fence.fenceToken]);
  });
  it("rejects observation replay/stale fence rather than silently finalizing twice", async () => {
    const fake = pool({ noObservation: true });
    await expect(createProviderCallRecorder(fake.instance, fence).finish(randomUUID(), { state: "uncertain", safeErrorCode: "PROVIDER_SUBMISSION_UNCERTAIN" })).rejects.toBeInstanceOf(ProviderCallRecordingError);
    expect(fake.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });
});
