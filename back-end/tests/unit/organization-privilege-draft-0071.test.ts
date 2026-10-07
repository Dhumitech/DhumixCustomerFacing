import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Offline ACL regression over the immutable migration chain and review draft.
// This checks declared grants, not inherited login privileges, RLS execution,
// trigger compilation or PostgreSQL locks. Those require separate real-role tests.
const review = new URL("../../scripts/refactor-review/", import.meta.url);
const migrations = new URL("../../scripts/migrations/", import.meta.url);
const draft = readFileSync(new URL("0071_organizations.draft.sql", review), "utf8");
const manifest = JSON.parse(readFileSync(new URL("0071_organizations.manifest.json", review), "utf8")) as {
  draftSha256: string; sourceLedger: { version: string; checksum: string }[];
  writePathQualified: boolean; runtimeActivation: boolean;
  postgresQualification: { path: string; sha256: string };
};
const historicalFiles = readdirSync(migrations).filter((file) => /^00(?:[0-6]\d|70)_.*\.sql$/.test(file)).sort();

function statements(sql: string): string[] {
  // Ignore quoted routine bodies, strings and comments; do not interpret GRANT
  // text inside a function as a top-level capability change.
  return sql.replace(/--[^\r\n]*|\/\*[\s\S]*?\*\/|\$([a-zA-Z_][a-zA-Z_0-9]*|)\$[\s\S]*?\$\1\$|'(?:''|[^'])*'/g, " ")
    .split(";").map((part) => part.trim());
}
interface Access { table: boolean; columns: Set<string> }
const grants = new Map<string, Access>();
function acl(role: string, table: string, privilege: string): Access {
  const key = `${role}:${table}:${privilege}`;
  const value = grants.get(key) ?? { table: false, columns: new Set<string>() };
  grants.set(key, value); return value;
}
function applyGrants(sql: string): void {
  for (const statement of statements(sql)) {
    const match = /^(GRANT|REVOKE)\s+([\s\S]+?)\s+ON\s+(?:TABLE\s+)?(app\.[\s\S]+?)\s+(?:TO|FROM)\s+([a-z_,\s]+)$/i.exec(statement);
    if (!match) continue;
    const [, action, privileges, targets, roles] = match;
    for (const target of targets!.split(",").map((name) => name.trim())) {
      if (!/^app\.[a-z_]+$/.test(target)) throw new Error(`Unsupported table grant: ${statement}`);
      for (const role of roles!.split(",").map((name) => name.trim())) {
        for (const privilege of privileges!.matchAll(/(SELECT|INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER|ALL)(?:\s+PRIVILEGES)?\s*(?:\(([^)]*)\))?/gi)) {
          const names = privilege[1]!.toUpperCase() === "ALL"
            ? ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"] : [privilege[1]!.toUpperCase()];
          for (const name of names) {
            const access = acl(role, target, name);
            if (privilege[2]) {
              for (const column of privilege[2].split(",").map((value) => value.trim())) {
                if (action!.toUpperCase() === "GRANT") access.columns.add(column);
                else access.columns.delete(column);
              }
            } else access.table = action!.toUpperCase() === "GRANT";
          }
        }
      }
    }
  }
}
for (const file of historicalFiles) applyGrants(readFileSync(new URL(file, migrations), "utf8"));
applyGrants(draft);
function allowed(role: string, table: string, privilege: string, columns: string[]): boolean {
  const access = acl(role, `app.${table}`, privilege);
  return access.table || columns.every((column) => access.columns.has(column));
}

describe("0071 review privileges (offline declaration checks only)", () => {
  it("pins the exact review SQL and all 70 historical migration bytes", () => {
    expect(createHash("sha256").update(draft).digest("hex")).toBe(manifest.draftSha256);
    expect(historicalFiles).toHaveLength(70);
    for (const file of historicalFiles) {
      expect(createHash("sha256").update(readFileSync(new URL(file, migrations))).digest("hex"))
        .toBe(manifest.sourceLedger.find((entry) => `${entry.version}.sql` === file)?.checksum);
    }
  });
  it.each([
    ["users", "INSERT", ["id", "email_normalized", "password_hash"]],
    ["users", "UPDATE", ["password_hash", "state", "email_verified_at", "failed_auth_count", "last_failed_auth_at"]],
    ["auth_sessions", "INSERT", ["id", "user_id", "token_family_hash", "expires_at"]],
    ["auth_sessions", "UPDATE", ["token_family_hash", "state", "revoked_at", "revoked_reason"]],
    ["auth_refresh_tokens", "INSERT", ["id", "session_id", "token_hash", "generation"]],
    ["auth_refresh_tokens", "UPDATE", ["state", "ended_at"]],
    ["email_verifications", "INSERT", ["id", "user_id", "purpose", "code_hash", "payload", "expires_at", "trace_id"]],
    ["email_verifications", "UPDATE", ["attempt_count", "consumed_at", "payload"]],
    ["tenants", "INSERT", ["id", "display_name", "created_by_user_id"]],
    ["tenant_user_access", "UPDATE", ["state", "access_role", "invite_id"]],
    ["organization_invites", "UPDATE", ["use_count"]],
  ] as const)("permits identity writer %s %s columns", (table, privilege, columns) => {
    expect(allowed("dhumi_identity", table, privilege, [...columns])).toBe(true);
  });
  it("permits both customer replay completion and customer audit append", () => {
    expect(allowed("dhumi_customer_api", "idempotency_records", "UPDATE", ["state", "response_status", "response_body", "response_body_reference", "completed_at"])).toBe(true);
    expect(allowed("dhumi_customer_api", "audit_events", "INSERT", ["tenant_id", "actor_user_id", "action", "target_type", "target_id", "outcome", "request_id"])).toBe(true);
  });
  it("permits admission's exact user, organization, membership and access reads", () => {
    for (const [table, columns] of [
      ["users", ["id", "state"]], ["tenants", ["id", "state"]],
      ["tenant_user_access", ["tenant_id", "user_id", "state"]],
      ["service_templates", ["id", "access"]], ["organization_templates", ["organization_id", "service_template_id"]],
    ] as const) expect(allowed("dhumi_admission", table, "SELECT", [...columns])).toBe(true);
    expect(allowed("dhumi_admission", "users", "SELECT", ["password_hash"])).toBe(false);
  });
  it("supplies one UPDATE column for admission/identity organization locks without mutable fields", () => {
    for (const role of ["dhumi_identity", "dhumi_admission"]) {
      expect(allowed(role, "tenants", "UPDATE", ["id"])).toBe(true);
      for (const field of ["display_name", "state", "created_by_user_id", "is_internal", "created_at"])
        expect(allowed(role, "tenants", "UPDATE", [field])).toBe(false);
    }
    expect(allowed("dhumi_admission", "tenant_user_access", "UPDATE", ["user_id"])).toBe(true);
    for (const field of ["access_role", "state", "invite_id", "created_at"])
      expect(allowed("dhumi_admission", "tenant_user_access", "UPDATE", [field])).toBe(false);
  });
  it("denies runtime issuance clocks, creator mutation and customer membership identity changes", () => {
    for (const table of ["users", "auth_sessions", "auth_refresh_tokens", "email_verifications", "tenants", "tenant_user_access"]) {
      for (const privilege of ["INSERT", "UPDATE"])
        expect(allowed("dhumi_identity", table, privilege, ["created_at"])).toBe(false);
    }
    for (const field of ["created_by_user_id", "is_internal", "id", "created_at"])
      expect(allowed("dhumi_customer_api", "tenants", "UPDATE", [field])).toBe(false);
    for (const field of ["tenant_id", "user_id", "invite_id", "created_at"])
      expect(allowed("dhumi_customer_api", "tenant_user_access", "UPDATE", [field])).toBe(false);
  });
  it("keeps append-only identity/customer ledgers and expiry-only cleanup grants", () => {
    for (const role of ["dhumi_identity", "dhumi_customer_api"])
      for (const table of ["audit_events", "legal_acceptances"])
        for (const privilege of ["UPDATE", "DELETE"])
          expect(allowed(role, table, privilege, ["id"])).toBe(false);
    expect(allowed("dhumi_job_manager", "email_verifications", "DELETE", ["id"])).toBe(true);
    expect(allowed("dhumi_job_manager", "email_verifications", "UPDATE", ["expires_at"])).toBe(false);
  });
  it("retains refusal gates and never changes identities, history, RLS enablement or the migration ledger", () => {
    const sql = statements(draft);
    expect(sql.some((statement) => /^(CREATE|ALTER|DROP)\s+(ROLE|USER)\b/i.test(statement))).toBe(false);
    expect(sql.some((statement) => /^(DROP TABLE|COMMIT|ROLLBACK)\b/i.test(statement))).toBe(false);
    expect(sql.some((statement) => /DISABLE\s+(ROW LEVEL SECURITY|TRIGGER)|INSERT INTO app\.schema_migrations/i.test(statement))).toBe(false);
    expect(draft.indexOf("DO $execution_gate$")).toBeLessThan(draft.indexOf("ALTER TABLE app.tenants ADD COLUMN"));
    expect(manifest.writePathQualified).toBe(true);
    expect(manifest.runtimeActivation).toBe(false);
    const canonical = readFileSync(new URL("0071_organizations.sql", migrations));
    expect(createHash("sha256").update(canonical).digest("hex")).toBe(manifest.draftSha256);
    // The full qualification receipt is private local evidence. A checked-in
    // summary makes this declaration test portable without exporting backups,
    // data digests or source/evidence inventories. It cannot authorize Apply.
    const summary = JSON.parse(readFileSync(new URL("../fixtures/0071-qualification-summary.json", import.meta.url), "utf8"));
    expect(summary.originalReceiptSha256).toBe(manifest.postgresQualification.sha256);
    expect(summary.qualification).toMatchObject({ status: "PASSED", writePathQualified: true, mainUnchanged: true, migrationApplied: false, draftSha256: manifest.draftSha256 });
  });
});
