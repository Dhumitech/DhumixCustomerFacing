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
  role: "member",
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

  it("rejects non-browser actors before any workspace lookup", async () => {
    const store = repository(workspace);
    const service = createWorkspaceService({ repository: store });
    const invalid = { kind: "api_key", tenantId: identity.tenantId } as unknown as typeof identity;
    await expect(service.getWorkspace(invalid)).rejects.toMatchObject({ status: 403, code: "ACCESS_DENIED" });
    expect(store.calls).toHaveLength(0);
  });

  it("turns an RLS-hidden or unavailable row into the declared 403", async () => {
    const service = createWorkspaceService({ repository: repository(undefined) });

    await expect(service.getWorkspace(identity)).rejects.toMatchObject({
      status: 403,
      code: "ACCESS_DENIED",
    });
  });

  it("preserves repository failures for centralized safe error handling", async () => {
    const failure = new Error("database unavailable");
    const service = createWorkspaceService({
      repository: {
        async findBrowserWorkspace() {
          throw failure;
        },
      },
    });

    await expect(service.getWorkspace(identity)).rejects.toBe(failure);
  });
});
