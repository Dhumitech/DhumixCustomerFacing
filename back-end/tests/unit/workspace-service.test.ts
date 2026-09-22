import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  WorkspaceLookup,
  WorkspaceRecord,
  WorkspaceRepository,
} from "../../src/services/workspace/workspaceRepository.js";
import { createWorkspaceService } from "../../src/services/workspace/workspaceService.js";

const identity = {
  kind: "browser" as const,
  userId: randomUUID(),
  sessionId: randomUUID(),
  tenantId: randomUUID(),
};
const workspace: WorkspaceRecord = {
  id: identity.tenantId,
  name: "Acme Research",
  state: "active",
  createdAt: new Date("2026-08-23T10:20:30.000Z"),
};

function repository(
  result: WorkspaceRecord | undefined,
): WorkspaceRepository & { readonly calls: WorkspaceLookup[] } {
  const calls: WorkspaceLookup[] = [];
  return {
    calls,
    async findBrowserWorkspace(input) {
      calls.push(input);
      return result;
    },
    async findApiKeyWorkspace() {
      throw new Error("API-key workspace lookup was not expected");
    },
  };
}

describe("workspace service", () => {
  it("reads the workspace through the trusted User and Tenant pair", async () => {
    const store = repository(workspace);
    const service = createWorkspaceService({ repository: store });

    await expect(service.getWorkspace(identity)).resolves.toBe(workspace);
    expect(store.calls).toEqual([
      { userId: identity.userId, tenantId: identity.tenantId },
    ]);
  });

  it("reads an API-key workspace without manufacturing browser identity", async () => {
    const calls: string[] = [];
    const service = createWorkspaceService({
      repository: {
        async findBrowserWorkspace() {
          throw new Error("browser lookup was not expected");
        },
        async findApiKeyWorkspace(tenantId) {
          calls.push(tenantId);
          return workspace;
        },
      },
    });

    await expect(
      service.getWorkspace({
        kind: "api_key",
        apiKeyId: randomUUID(),
        tenantId: identity.tenantId,
        scopes: ["catalog:read"],
      }),
    ).resolves.toBe(workspace);
    expect(calls).toEqual([identity.tenantId]);
  });

  it("turns an RLS-hidden or unavailable row into the declared 403", async () => {
    const service = createWorkspaceService({ repository: repository(undefined) });

    await expect(service.getWorkspace(identity)).rejects.toMatchObject({
      status: 403,
      code: "ACCESS_DENIED",
    });
  });

  it("uses the generic access denial when an API-key Tenant disappears", async () => {
    const service = createWorkspaceService({
      repository: {
        async findBrowserWorkspace() {
          throw new Error("browser lookup was not expected");
        },
        async findApiKeyWorkspace() {
          return undefined;
        },
      },
    });

    await expect(
      service.getWorkspace({
        kind: "api_key",
        apiKeyId: randomUUID(),
        tenantId: identity.tenantId,
        scopes: ["catalog:read"],
      }),
    ).rejects.toMatchObject({ status: 403, code: "ACCESS_DENIED" });
  });

  it("preserves repository failures for centralized safe error handling", async () => {
    const failure = new Error("database unavailable");
    const service = createWorkspaceService({
      repository: {
        async findBrowserWorkspace() {
          throw failure;
        },
        async findApiKeyWorkspace() {
          throw failure;
        },
      },
    });

    await expect(service.getWorkspace(identity)).rejects.toBe(failure);
  });
});
