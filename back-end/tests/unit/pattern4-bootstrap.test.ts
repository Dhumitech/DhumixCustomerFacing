import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Pattern 4 runtime bootstrap", () => {
  it("creates separate NOINHERIT LOGIN roles with SET-only memberships", () => {
    const sql = readFileSync(
      resolve("scripts/bootstrap/0009_pattern4_runtime_roles.sql"),
      "utf8",
    );
    expect(sql).toContain("NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE");
    expect(sql).toContain('GRANT dhumi_outbox_dispatcher TO :"outbox_dispatcher_login_role"');
    expect(sql).toContain('GRANT dhumi_job_manager TO :"job_manager_login_role"');
    expect(sql.match(/WITH INHERIT FALSE, SET TRUE/g)).toHaveLength(2);
    expect(sql).not.toContain("BYPASSRLS TO");
  });

  it("keeps the cluster-role safety preflight compatible with both approved memberships", () => {
    const preflight = readFileSync(resolve("scripts/bootstrap/0001_cluster_roles.sql"), "utf8");
    expect(preflight).toContain("^dhumi_[a-z0-9_]+_outbox_dispatcher_login$");
    expect(preflight).toContain("^dhumi_[a-z0-9_]+_job_manager_login$");
    expect(preflight).toContain("'dhumi_outbox_dispatcher',");
    expect(preflight).toContain("'dhumi_job_manager'");
  });
});
