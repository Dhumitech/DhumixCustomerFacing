import { describe, expect, it } from "vitest";
import type { ResultUrlSigner } from "../../src/helpers/resultUrlSigner.js";
import type {
  GetRunResultAuditInput,
  GetRunResultRepository,
  GetRunResultRepositoryInput,
  GetRunResultRepositoryOutcome,
} from "../../src/services/runQuery/getRunResultRepository.js";
import { createGetRunResultService } from "../../src/services/runQuery/getRunResultService.js";

const principal = {
  kind: "browser",
  userId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  tenantId: "33333333-3333-4333-8333-333333333333",
} as const;
const runId = "44444444-4444-4444-8444-444444444444";

class RecordingRepository implements GetRunResultRepository {
  public readonly calls: GetRunResultRepositoryInput[] = [];
  public readonly auditCalls: GetRunResultAuditInput[] = [];

  public constructor(public outcome: GetRunResultRepositoryOutcome) {}

  public async findResult(
    input: GetRunResultRepositoryInput,
  ): Promise<GetRunResultRepositoryOutcome> {
    this.calls.push(input);
    return this.outcome;
  }

  public async recordDownloadAuthorization(
    input: GetRunResultAuditInput,
  ): Promise<void> {
    this.auditCalls.push(input);
  }
}

class RecordingSigner implements ResultUrlSigner {
  public readonly calls: Parameters<ResultUrlSigner["sign"]>[0][] = [];

  public async sign(input: Parameters<ResultUrlSigner["sign"]>[0]) {
    this.calls.push(input);
    return {
      downloadUrl: "https://downloads.dhumi.example/capability/opaque",
      expiresAt: new Date("2026-08-27T12:15:00.000Z"),
      transport: "https" as const,
    };
  }
}

function request(
  runIdInput: unknown = runId,
  representation: unknown = undefined,
) {
  return {
    principal,
    runId: runIdInput,
    representation,
    schemaErrors: [],
    requestId: "55555555-5555-4555-8555-555555555555",
    ipFingerprint: Buffer.from("12".repeat(32), "hex"),
  };
}

function ready(): GetRunResultRepositoryOutcome {
  return {
    kind: "ready",
    artifact: {
      artifactId: "66666666-6666-4666-8666-666666666666",
      objectKey: "tenant/internal/object-key",
      contentType: "application/json",
      byteCount: "42891",
      checksum: Buffer.from("ab".repeat(32), "hex"),
    },
  };
}

describe("getRunResultService", () => {
  it("returns exactly the public RunResult and keeps the object key private", async () => {
    const repository = new RecordingRepository(ready());
    const signer = new RecordingSigner();

    const result = await createGetRunResultService({ repository, urlSigner: signer }).get(
      request(),
    );

    expect(repository.calls).toEqual([
      { tenantId: principal.tenantId, runId, representation: "normalized" },
    ]);
    expect(signer.calls).toEqual([
      {
        tenantId: principal.tenantId,
        runId,
        objectKey: "tenant/internal/object-key",
        contentType: "application/json",
        byteCount: 42891,
        checksumHex: "ab".repeat(32),
      },
    ]);
    expect(repository.auditCalls).toEqual([
      {
        tenantId: principal.tenantId,
        runId,
        artifactId: "66666666-6666-4666-8666-666666666666",
        representation: "normalized",
        actor: { kind: "browser", userId: principal.userId },
        requestId: "55555555-5555-4555-8555-555555555555",
        ipFingerprint: Buffer.from("12".repeat(32), "hex"),
      },
    ]);
    expect(result).toEqual({
      run_id: runId,
      content_type: "application/json",
      byte_count: 42891,
      checksum: "ab".repeat(32),
      download_url: "https://downloads.dhumi.example/capability/opaque",
      download_expires_at: "2026-08-27T12:15:00.000Z",
    });
    expect(JSON.stringify(result)).not.toMatch(/object-key|tenant_id|attempt|provider/i);
  });

  it("selects and audits the explicit raw representation", async () => {
    const repository = new RecordingRepository(ready());

    await createGetRunResultService({
      repository,
      urlSigner: new RecordingSigner(),
    }).get(request(runId, "raw"));

    expect(repository.calls).toEqual([
      { tenantId: principal.tenantId, runId, representation: "raw" },
    ]);
    expect(repository.auditCalls[0]).toMatchObject({ representation: "raw" });
  });

  it("rejects an invalid representation without querying the repository", async () => {
    const repository = new RecordingRepository(ready());

    await expect(
      createGetRunResultService({
        repository,
        urlSigner: new RecordingSigner(),
      }).get(request(runId, "provider")),
    ).rejects.toMatchObject({ status: 422, code: "VALIDATION_ERROR" });
    expect(repository.calls).toHaveLength(0);
  });

  it("maps malformed, missing, non-ready, and inconsistent result state safely", async () => {
    const malformedRepository = new RecordingRepository(ready());
    await expect(
      createGetRunResultService({
        repository: malformedRepository,
        urlSigner: new RecordingSigner(),
      }).get(request("not-a-uuid")),
    ).rejects.toMatchObject({ status: 404, code: "RESOURCE_NOT_FOUND" });
    expect(malformedRepository.calls).toHaveLength(0);

    for (const [outcome, expected] of [
      [{ kind: "not_found" }, { status: 404, code: "RESOURCE_NOT_FOUND" }],
      [{ kind: "not_ready" }, { status: 409, code: "STATE_CONFLICT" }],
      [{ kind: "missing_artifact" }, { status: 500, code: "INTERNAL_ERROR" }],
    ] as const) {
      await expect(
        createGetRunResultService({
          repository: new RecordingRepository(outcome),
          urlSigner: new RecordingSigner(),
        }).get(request()),
      ).rejects.toMatchObject(expected);
    }
  });

  it("fails closed when no real object-storage signer is available", async () => {
    const repository = new RecordingRepository(ready());
    const urlSigner: ResultUrlSigner = {
      async sign() {
        throw Object.assign(new Error("Result URL signing is unavailable"), {
          name: "ResultUrlSigningUnavailableError",
        });
      },
    };

    await expect(
      createGetRunResultService({
        repository,
        urlSigner,
      }).get(request()),
    ).rejects.toMatchObject({ status: 503, code: "SERVICE_UNAVAILABLE" });
    expect(repository.auditCalls).toHaveLength(0);
  });

  it("accepts signer-declared loopback HTTP only for local Azurite", async () => {
    const repository = new RecordingRepository(ready());
    const urlSigner: ResultUrlSigner = {
      async sign() {
        return {
          downloadUrl:
            "http://127.0.0.1:10000/devstoreaccount1/dhumi-results/object?sp=r&sig=opaque",
          expiresAt: new Date("2026-08-27T12:15:00.000Z"),
          transport: "loopback-http",
        };
      },
    };

    await expect(
      createGetRunResultService({ repository, urlSigner }).get(request()),
    ).resolves.toMatchObject({
      download_url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:10000\//),
    });
  });

  it("rejects non-loopback HTTP even when a signer claims local transport", async () => {
    const repository = new RecordingRepository(ready());
    const urlSigner: ResultUrlSigner = {
      async sign() {
        return {
          downloadUrl: "http://storage.example.test/result?sig=opaque",
          expiresAt: new Date("2026-08-27T12:15:00.000Z"),
          transport: "loopback-http",
        };
      },
    };

    await expect(
      createGetRunResultService({ repository, urlSigner }).get(request()),
    ).rejects.toMatchObject({ status: 500, code: "INTERNAL_ERROR" });
    expect(repository.auditCalls).toHaveLength(0);
  });

  it("does not disclose a signed URL when the mandatory audit transaction fails", async () => {
    const repository = new RecordingRepository(ready());
    repository.recordDownloadAuthorization = async () => {
      throw new Error("audit failed");
    };

    await expect(
      createGetRunResultService({
        repository,
        urlSigner: new RecordingSigner(),
      }).get(request()),
    ).rejects.toThrow("audit failed");
  });

  it("records the trusted Dhumi API-key actor without storing key material", async () => {
    const repository = new RecordingRepository(ready());
    const apiPrincipal = {
      kind: "api_key",
      apiKeyId: "77777777-7777-4777-8777-777777777777",
      tenantId: principal.tenantId,
      scopes: ["results:read"],
    } as const;

    await createGetRunResultService({
      repository,
      urlSigner: new RecordingSigner(),
    }).get({ ...request(), principal: apiPrincipal });

    expect(repository.auditCalls[0]?.actor).toEqual({
      kind: "api_key",
      apiKeyId: apiPrincipal.apiKeyId,
    });
    expect(JSON.stringify(repository.auditCalls[0])).not.toMatch(/dhk_|bearer|token/i);
  });
});
