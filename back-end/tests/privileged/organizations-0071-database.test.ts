import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { hash, verify } from "@node-rs/argon2";
import { Client, Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSignupRepository } from "../../src/services/identity/signupRepository.js";
import { createSignInRepository } from "../../src/services/identity/signInRepository.js";
import { createRefreshRepository } from "../../src/services/identity/refreshRepository.js";
import { createLogoutRepository } from "../../src/services/identity/logoutRepository.js";
import { createListCatalogTemplatesRepository } from "../../src/services/catalogue/listCatalogTemplatesRepository.js";
import { createGetCatalogTemplateRepository } from "../../src/services/catalogue/getCatalogTemplateRepository.js";
import { createOrganizationWorkflowRepository, type WorkflowRequest, type WorkflowResult } from "../../src/services/organizations/organizationWorkflowRepository.js";
import { withOrganizationWriteTransaction, withAdmissionOrganizationTransaction, withOrganizationAdministrationTransaction } from "../../src/services/database/transactions.js";
import { loadOrganizationInviteResendLifetimeDays } from "../../src/config/organizationEnvironment.js";

// Explicitly privileged, opt-in qualification. Committed fixtures/races occur
// ONLY in the restored same-named database on an isolated loopback instance.
// This file cannot run against main :5432 and never starts runtime/providers.
const enabled = process.env.RUN_0071_ORGANIZATION_QUALIFICATION === "true";
const env = enabled ? parseEnv(readFileSync(new URL("../../.env", import.meta.url), "utf8")) : {};
const port = Number(process.env.QUALIFICATION_POSTGRES_PORT ?? 65471);
if (enabled && (port !== 65471 || env.DATABASE_NAME !== "dhumi_test" || env.DATABASE_PORT !== "5432"))
  throw new Error("0071 qualification requires isolated loopback :65471/dhumi_test and the existing test profile");
const connection = { host: "127.0.0.1", port, database: "dhumi_test", connectionTimeoutMillis: 5000,
  statement_timeout: 15_000, query_timeout: 16_000, idle_in_transaction_session_timeout: 15_000, max: 8 };
function pool(name: string): Pool {
  const value = new Pool({ ...connection, user: env[`DATABASE_${name}_USER`], password: env[`DATABASE_${name}_PASSWORD`], application_name: `dhumi-0071-qualified-${name.toLowerCase()}` });
  value.on("error", () => {}); return value;
}
const identity = enabled ? pool("IDENTITY") : undefined;
const customer = enabled ? pool("CUSTOMER_API") : undefined;
const admission = enabled ? pool("ADMISSION") : undefined;
const jobManager = enabled ? pool("JOB_MANAGER") : undefined;
const admin = enabled ? new Client({ ...connection, user: env.POSTGRES_USER, password: env.POSTGRES_PASSWORD, application_name: "dhumi-0071-qualified-fixture-admin" }) : undefined;
const otpSecret = "0071-synthetic-mailbox-proof-secret-for-qualified-fixtures";
function must<T>(value: T | undefined): T { if (!value) throw Error("Explicit qualification unavailable"); return value; }
function repository(identityPool = must(identity), customerPool = must(customer), inviteResendLifetimeDays = loadOrganizationInviteResendLifetimeDays({})) {
  return createOrganizationWorkflowRepository({ identityPool, customerPool, otpSecret, publicUrl: "http://localhost:5173", inviteResendLifetimeDays });
}
const digest = (input: string) => createHash("sha256").update(input).digest();
const key = () => "0071-qual-" + randomUUID();
const request = (body: Record<string, unknown>, extra: Partial<WorkflowRequest> = {}): WorkflowRequest => ({ body, key: key(), traceId: randomUUID(), ...extra });
interface TestUser { id: string; email: string; password: string; passwordHash: string }
async function user(): Promise<TestUser> {
  const nonce = randomUUID(); const email = `0071-${nonce}@example.test`; const password = "Dhumi-Test-Only-" + nonce;
  const passwordHash = await hash(password, { memoryCost: 8192, timeCost: 1, parallelism: 1 });
  const outcome = await createSignupRepository(must(identity)).createSignup({ emailNormalized: email, passwordHash,
    legalAcceptances: [{ document_type: "terms", document_version: "0071-qualification-v1", document_hash_hex: digest("0071-terms").toString("hex"), disclosure_version: null }],
    idempotencyKey: key(), requestHash: digest(nonce), actorFingerprint: digest(email), requestId: randomUUID() });
  expect(outcome.kind).toBe("completed");
  if (outcome.kind !== "completed" || !outcome.userId) throw Error("Fixture signup failed");
  return { id: outcome.userId, email, password, passwordHash };
}
function code(result: WorkflowResult): string {
  const value = result.mail?.text.match(/\b\d{6}\b/)?.[0]; if (!value) throw Error("Synthetic verification mail has no code"); return value;
}
function verificationId(result: WorkflowResult): string { return String(result.response.verification_id); }
async function confirm(who: TestUser, issued: WorkflowResult, options: { body?: Record<string, unknown>; passwordHash?: string } = {}) {
  return repository().run("confirmVerification", request(options.body ?? { code: code(issued) }, { userId: who.id, verificationId: verificationId(issued), ...(options.passwordHash ? { passwordHash: options.passwordHash } : {}) }));
}
async function organization(ownerInput?: TestUser) {
  const owner = ownerInput ?? await user();
  const pending = await repository().run("createOrganization", request({ name: "Qualified " + randomUUID() }, { userId: owner.id }));
  const result = await confirm(owner, pending); return { owner, id: String(result.response.organization_id) };
}
async function invite(org: { id: string; owner: TestUser }, options: Record<string, unknown> = {}) {
  const result = await repository().run("createInvite", request({ role: "member", expires_at: new Date(Date.now() + 3_600_000).toISOString(), ...options }, { userId: org.owner.id, organizationId: org.id }));
  const metadata = result.response.invite as { id: string };
  return { id: metadata.id, token: String(result.response.join_code ?? result.response.invite_token), result };
}
async function join(org: { id: string; owner: TestUser }, whoInput?: TestUser, options: Record<string, unknown> = {}) {
  const who = whoInput ?? await user();
  const invitation = await invite(org, options);
  const pending = await repository().run("acceptInvite", request({ join_code: invitation.token }, { userId: who.id }));
  const result = await confirm(who, pending); expect(result.response.organization_id).toBe(org.id); return who;
}
async function scalar(sql: string, values: readonly unknown[] = []) { return (await must(admin).query(sql, [...values])).rows[0]; }
async function catalogue(access: "all" | "selected") {
  const slug = "qualified-" + randomUUID(), templateId = randomUUID(), versionId = randomUUID();
  const adapterId = randomUUID(), adapterVersionId = randomUUID(), evidenceId = randomUUID();
  const c = must(admin);
  await c.query("BEGIN");
  try {
    await c.query("INSERT INTO app.adapter_definitions(id,code,product_family) VALUES($1,$2,'scraper_library')", [adapterId,slug]);
    await c.query("INSERT INTO app.adapter_versions(id,adapter_definition_id,semantic_version,code_artifact_digest,state) VALUES($1,$2,'1.0.0',$3,'enabled')", [adapterVersionId,adapterId,digest(slug)]);
    await c.query(`INSERT INTO app.launch_evidence(id,evidence_code,scope_type,scope_key,state,restricted_reference,effective_at,expires_at,approved_by,approved_at)
      VALUES($1,$2,'template',$2,'approved','restricted:isolated-0071-qualification',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour','isolated-fixture',clock_timestamp())`,[evidenceId,slug]);
    await c.query("INSERT INTO app.service_templates(id,slug,product_family,access) VALUES($1,$2,'scraper_library',$3)",[templateId,slug,access]);
    await c.query(`INSERT INTO app.service_template_versions(id,service_template_id,version,public_name,public_description,input_schema,output_schema,
      configuration_schema,presentation_metadata,availability_copy,availability_state,adapter_version_id,launch_evidence_id,effective_at,published_at)
      VALUES($1,$2,1,'Isolated qualification','Synthetic published catalogue fixture','{}','{}','{}',$3::jsonb,'Available','available',$4,$5,clock_timestamp()-interval '1 minute',clock_timestamp()-interval '1 minute')`,
      [versionId,templateId,JSON.stringify({domain_slug:"qualification",domain_name:"Qualification",category:"Qualification",icon_key:"qualification",operation_group:"qualification",operation_name:"Qualification",display_priority:1}),adapterVersionId,evidenceId]);
    await c.query("UPDATE app.service_templates SET state='published',current_public_version_id=$2 WHERE id=$1",[templateId,versionId]);
    await c.query("COMMIT");
    return { id:templateId, versionId, slug };
  } catch(error) { await c.query("ROLLBACK"); throw error; }
}
function latch() {
  let release!: () => void;
  const reached = new Promise<void>(resolve => { release = resolve; });
  return { reached, release };
}
// Observe real pg clients/queries; no rows or PostgreSQL outcomes are mocked.
// Pause after a matched real query has completed and retains its real locks.
function pausedPool(real: Pool, match: (sql: string) => boolean) {
  const held = latch(), resume = latch(); let stopped = false, backendPid = 0;
  const wrapped = new Proxy(real, { get(target, property) {
    if(property === "connect") return async () => {
      const c = await target.connect();
      backendPid = (await c.query("SELECT pg_backend_pid() pid")).rows[0].pid;
      return new Proxy(c, { get(client, member) {
        if(member === "query") return async (...args: [string, unknown[]?]) => {
          const result = await client.query(...args);
          if(!stopped && match(args[0])) { stopped = true; held.release(); await resume.reached; }
          return result;
        };
        const value = Reflect.get(client,member); return typeof value === "function" ? value.bind(client) : value;
      } });
    };
    const value = Reflect.get(target,property); return typeof value === "function" ? value.bind(target) : value;
  } });
  return { pool:wrapped, held:held.reached, release:resume.release, pid:() => backendPid };
}
async function blockedBy(pid: number) {
  const deadline = Date.now()+5000;
  while(Date.now()<deadline) {
    const row = await scalar("SELECT count(*)::int n FROM pg_stat_activity WHERE datname='dhumi_test' AND $1=ANY(pg_blocking_pids(pid))",[pid]);
    if(row.n>0) return;
    await new Promise(resolve => setTimeout(resolve,20));
  }
  throw Error("PostgreSQL did not demonstrate the required lock wait");
}
async function session(who: TestUser) {
  const tokenHash = digest(key());
  const outcome = await createSignInRepository(must(identity)).createSession({userId:who.id,tokenFamilyHash:tokenHash,expiresAt:new Date(Date.now()+3_600_000)},
    {tenantId:null,actorUserId:who.id,action:"identity.signin",outcome:"success",requestId:randomUUID(),ipFingerprint:null},
    {verifiedPasswordHash:who.passwordHash,allowExpiredLock:false,lockoutWindowMs:60000});
  if(outcome.kind!=="created") throw Error("Qualified sign-in failed");
  return {id:outcome.sessionId,tokenHash};
}
async function inRole(rolePool: Pool, role: string, context: { userId?: string; orgId?: string; proofId?: string; tokenHash?: string }, work: (c: PoolClient) => Promise<void>) {
  if (!/^dhumi_(identity|customer_api|admission|job_manager|operator)$/.test(role)) throw Error("Static test role required");
  const c = await rolePool.connect();
  try { await c.query("BEGIN"); await c.query("SET LOCAL ROLE " + role);
    await c.query("SELECT set_config('app.user_id',$1,true),set_config('app.tenant_id',$2,true),set_config('app.verification_id',$3,true),set_config('app.invite_token_hash',$4,true)", [context.userId ?? "", context.orgId ?? "", context.proofId ?? "", context.tokenHash ?? ""]);
    await work(c);
  } finally { await c.query("ROLLBACK"); c.release(); }
}
async function denied(c: PoolClient, sql: string, values: readonly unknown[] = [], state = "42501") {
  await c.query("SAVEPOINT rejected_statement");
  try { await expect(c.query(sql, [...values])).rejects.toMatchObject({ code: state }); }
  finally { await c.query("ROLLBACK TO SAVEPOINT rejected_statement"); }
}
beforeAll(async () => {
  if (!enabled) return;
  await must(admin).connect();
  const target = await scalar("SELECT current_database() db,inet_server_port() port,(SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app' AND c.relkind='r') tables");
  expect(target).toEqual({ db: "dhumi_test", port: 65471, tables: 35 });
  const guards = await scalar("SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app' AND c.relname IN('users','tenants','tenant_user_access','email_verifications','organization_invites','organization_templates') AND c.relrowsecurity AND c.relforcerowsecurity");
  expect(guards.n).toBe(6);
});
afterAll(async () => { await Promise.all([identity?.end(), customer?.end(), admission?.end(), jobManager?.end(), admin?.end()]); });

describe.skipIf(!enabled)("0071 source workflows under real retained PostgreSQL logins", () => {
  it("keeps user-only signup, legal facts and global browse without organization membership", async () => {
    const who = await user(); const publicTemplate = await catalogue("all");
    expect((await scalar("SELECT count(*)::int n FROM app.tenant_user_access WHERE user_id=$1", [who.id])).n).toBe(0);
    expect((await scalar("SELECT count(*)::int n FROM app.legal_acceptances WHERE user_id=$1 AND trace_id IS NOT NULL", [who.id])).n).toBe(1);
    await inRole(must(customer), "dhumi_customer_api", { userId: who.id }, async c => {
      expect((await c.query("SELECT count(*)::int n FROM app.service_templates WHERE state='published' AND access='all'")).rows[0].n).toBeGreaterThan(0);
      await denied(c, "SELECT password_hash FROM app.users");
    });
    const rows = await createListCatalogTemplatesRepository(must(customer)).list({userId:who.id,family:undefined,cursor:undefined,fetchLimit:101});
    expect(rows.some(row=>row.id===publicTemplate.id)).toBe(true);
  });
  it("creates nothing before fresh proof, then creates the immutable creator and first admin once", async () => {
    const who = await user(); const req = request({ name: "Pending proof " + randomUUID() }, { userId: who.id });
    const pending = await repository().run("createOrganization", req);
    expect((await scalar("SELECT count(*)::int n FROM app.tenants WHERE created_by_user_id=$1", [who.id])).n).toBe(0);
    const confirming = request({ code: code(pending) }, { userId: who.id, verificationId: verificationId(pending) });
    const first = await repository().run("confirmVerification", confirming);
    const replay = await repository().run("confirmVerification", confirming);
    expect(replay.response).toEqual(first.response);
    expect(await scalar("SELECT count(*)::int n FROM app.tenants WHERE created_by_user_id=$1 AND NOT is_internal", [who.id])).toEqual({ n: 1 });
    expect(await scalar("SELECT count(*)::int n FROM app.tenant_user_access WHERE user_id=$1 AND state='active' AND access_role='admin'", [who.id])).toEqual({ n: 1 });
    expect(await scalar("SELECT payload,consumed_at IS NOT NULL consumed FROM app.email_verifications WHERE id=$1", [verificationId(pending)])).toEqual({ payload: null, consumed: true });
  });
  it("ordinary members/admission can lock their own scope while direct administration and cross-scope access fail", async () => {
    const org = await organization(); const member = await join(org); const another = await organization();
    await withOrganizationWriteTransaction(must(customer), { userId: member.id, tenantId: org.id }, async db => {
      expect((await db.query("SELECT id FROM app.tenants WHERE id=$1", [org.id])).rowCount).toBe(1);
    });
    await withAdmissionOrganizationTransaction(must(admission), { userId: member.id, tenantId: org.id }, async () => {});
    await inRole(must(customer), "dhumi_customer_api", { userId: member.id, orgId: org.id }, async c => {
      expect((await c.query("SELECT id FROM app.tenants WHERE id=$1 FOR UPDATE", [another.id])).rowCount).toBe(0);
      expect((await c.query("SELECT user_id FROM app.tenant_user_access WHERE tenant_id=$1 FOR UPDATE", [another.id])).rowCount).toBe(0);
      await denied(c, "UPDATE app.tenant_user_access SET access_role='admin' WHERE tenant_id=$1 AND user_id=$2", [org.id, member.id]);
      await denied(c, "UPDATE app.tenants SET display_name='Unauthorized change' WHERE id=$1", [org.id]);
      await denied(c, "UPDATE app.tenants SET created_by_user_id=$2 WHERE id=$1", [org.id, member.id]);
    });
    await inRole(must(admission), "dhumi_admission", { userId: member.id, orgId: org.id }, async c => {
      expect((await c.query("SELECT id FROM app.tenants WHERE id=$1 FOR SHARE", [org.id])).rowCount).toBe(1);
      expect((await c.query("SELECT user_id FROM app.tenant_user_access WHERE tenant_id=$1 AND user_id=$2 FOR SHARE", [org.id, member.id])).rowCount).toBe(1);
      await denied(c, "UPDATE app.tenants SET id=id WHERE id=$1", [org.id]);
      await denied(c, "UPDATE app.tenant_user_access SET user_id=user_id WHERE tenant_id=$1 AND user_id=$2", [org.id, member.id]);
      await denied(c, "SELECT password_hash FROM app.users WHERE id=$1", [member.id]);
    });
  });
  it("joins a zero-membership user, locks an active own row without changing role/invite/use, and reactivates removed history", async () => {
    const org = await organization(); const member = await join(org);
    const original = await scalar("SELECT access_role,invite_id,created_at FROM app.tenant_user_access WHERE tenant_id=$1 AND user_id=$2", [org.id, member.id]);
    // A second fresh proof is issued after the original cooldown. Admin clock
    // setup only changes disposable challenge clocks in the isolated fixture.
    await must(admin).query("UPDATE app.email_verifications SET created_at=created_at-interval '61 seconds',expires_at=expires_at-interval '61 seconds' WHERE user_id=$1", [member.id]);
    const upgrade = await invite(org, { role: "admin" });
    const pending = await repository().run("acceptInvite", request({ join_code: upgrade.token }, { userId: member.id }));
    await confirm(member, pending);
    expect(await scalar("SELECT access_role,invite_id,created_at FROM app.tenant_user_access WHERE tenant_id=$1 AND user_id=$2", [org.id, member.id])).toEqual(original);
    expect((await scalar("SELECT use_count FROM app.organization_invites WHERE id=$1", [upgrade.id])).use_count).toBe(0);
    await repository().run("removeMember", request({}, { userId: org.owner.id, organizationId: org.id, targetId: member.id }));
    await must(admin).query("UPDATE app.email_verifications SET created_at=created_at-interval '61 seconds',expires_at=expires_at-interval '61 seconds' WHERE user_id=$1 AND consumed_at IS NULL", [member.id]);
    // Shift all issuance rows, including the consumed no-op proof, past cooldown.
    await must(admin).query("UPDATE app.email_verifications SET created_at=created_at-interval '61 seconds',expires_at=expires_at-interval '61 seconds' WHERE user_id=$1 AND consumed_at IS NOT NULL", [member.id]);
    const rejoin = await repository().run("acceptInvite", request({ join_code: upgrade.token }, { userId: member.id }));
    await confirm(member, rejoin);
    const after = await scalar("SELECT access_role,invite_id,created_at FROM app.tenant_user_access WHERE tenant_id=$1 AND user_id=$2", [org.id, member.id]);
    expect(after).toEqual({ access_role: "admin", invite_id: upgrade.id, created_at: original.created_at });
    expect((await scalar("SELECT use_count FROM app.organization_invites WHERE id=$1", [upgrade.id])).use_count).toBe(1);
  });
  it("kills a code after five committed failures without allowing a reused failed key to bypass counting", async () => {
    const who = await user(); const pending = await repository().run("createOrganization", request({ name: "Five failures" }, { userId: who.id }));
    const wrong = code(pending) === "000000" ? "000001" : "000000";
    const firstReq = request({ code: wrong }, { userId: who.id, verificationId: verificationId(pending) });
    expect((await repository().run("confirmVerification", firstReq)).failure?.status).toBe(409);
    await expect(repository().run("confirmVerification", firstReq)).rejects.toMatchObject({ status: 409 });
    for (let i=1;i<5;i++) expect((await repository().run("confirmVerification", request({ code: wrong }, { userId: who.id, verificationId: verificationId(pending) }))).failure?.status).toBe(409);
    expect(await scalar("SELECT attempt_count,payload,consumed_at IS NOT NULL consumed FROM app.email_verifications WHERE id=$1", [verificationId(pending)])).toEqual({ attempt_count: 5, payload: null, consumed: true });
    await expect(confirm(who, pending)).rejects.toMatchObject({ status: 409 });
  });
  it("denies cross-user proof and unbound create lookup while accepting one bound public reset challenge", async () => {
    const who = await user(), outsider = await user();
    const pending = await repository().run("createOrganization", request({ name: "Bound mailbox" }, { userId: who.id }));
    await inRole(must(identity), "dhumi_identity", { userId: outsider.id, proofId: verificationId(pending) }, async c => {
      expect((await c.query("SELECT id FROM app.email_verifications WHERE id=$1", [verificationId(pending)])).rowCount).toBe(0);
    });
    await inRole(must(identity), "dhumi_identity", { proofId: verificationId(pending) }, async c => {
      expect((await c.query("SELECT id FROM app.email_verifications WHERE id=$1", [verificationId(pending)])).rowCount).toBe(0);
    });
    const reset = await repository().run("passwordReset", request({ email: outsider.email }));
    await inRole(must(identity), "dhumi_identity", { proofId: verificationId(reset) }, async c => {
      expect((await c.query("SELECT id FROM app.email_verifications WHERE id=$1", [verificationId(reset)])).rowCount).toBe(1);
      await denied(c, "UPDATE app.email_verifications SET expires_at=expires_at+interval '1 hour' WHERE id=$1", [verificationId(reset)]);
    });
  });
  it("allows creator self-step-down completion, protects the creator/last admin, and keeps removed member history", async () => {
    const org = await organization(); const second = await join(org, await user(), { role: "admin" });
    await expect(repository().run("removeMember", request({}, { userId: second.id, organizationId: org.id, targetId: org.owner.id }))).rejects.toMatchObject({status:403,code:"ACCESS_DENIED"});
    const req = request({ role: "member" }, { userId: org.owner.id, organizationId: org.id, targetId: org.owner.id });
    await repository().run("changeMember", req);
    expect((await scalar("SELECT state,response_body FROM app.idempotency_records WHERE tenant_id=$1 AND idempotency_key=$2", [org.id, req.key])).state).toBe("completed");
    await expect(repository().run("changeMember", req)).rejects.toMatchObject({ status: 403 });
    await expect(repository().run("removeMember", request({}, { userId: second.id, organizationId: org.id, targetId: second.id }))).rejects.toThrow("administrator");
    const remove = request({}, { userId: second.id, organizationId: org.id, targetId: org.owner.id });
    await repository().run("removeMember", remove);
    expect((await scalar("SELECT state FROM app.tenant_user_access WHERE tenant_id=$1 AND user_id=$2", [org.id, org.owner.id])).state).toBe("removed");
    expect((await scalar("SELECT count(*)::int n FROM app.audit_events WHERE tenant_id=$1 AND actor_user_id=$2", [org.id, second.id])).n).toBeGreaterThan(0);
  });
  it("uses real session families: refresh pointer rotates, OTP reset revokes all families and changes password", async () => {
    const who = await user(); const signIn = createSignInRepository(must(identity));
    const firstHash = digest(key()), secondHash = digest(key());
    const audit = { tenantId: null, actorUserId: who.id, action: "identity.signin", outcome: "success", requestId: randomUUID(), ipFingerprint: null };
    const session = await signIn.createSession({ userId: who.id, tokenFamilyHash: firstHash, expiresAt: new Date(Date.now()+3_600_000) }, audit, { verifiedPasswordHash: who.passwordHash, allowExpiredLock: false, lockoutWindowMs: 60000 });
    expect(session.kind).toBe("created"); if (session.kind!=="created") throw Error("Session unavailable");
    const rotated = await createRefreshRepository(must(identity)).rotate({ expectedSessionId: session.sessionId, presentedTokenHash: firstHash, replacementTokenHash: secondHash, requestId: randomUUID(), ipFingerprint: null });
    expect(rotated.kind).toBe("rotated");
    expect((await scalar("SELECT encode(token_family_hash,'hex') value FROM app.auth_sessions WHERE id=$1", [session.sessionId])).value).toBe(secondHash.toString("hex"));
    const reset = await repository().run("passwordReset", request({ email: who.email }));
    const newPassword = "New-Test-Password-"+randomUUID(); const newHash = await hash(newPassword,{memoryCost:8192,timeCost:1,parallelism:1});
    const result = await repository().run("confirmVerification", request({ code:code(reset),new_password:newPassword }, { verificationId: verificationId(reset), passwordHash:newHash }));
    expect(result.response.sign_in_required).toBe(true);
    expect(await scalar("SELECT state,revoked_reason FROM app.auth_sessions WHERE id=$1",[session.sessionId])).toEqual({state:"revoked",revoked_reason:"password_reset"});
    expect((await scalar("SELECT count(*)::int n FROM app.auth_refresh_tokens WHERE session_id=$1 AND(state='active' OR ended_at IS NULL)",[session.sessionId])).n).toBe(0);
    expect(await verify((await scalar("SELECT password_hash FROM app.users WHERE id=$1",[who.id])).password_hash,newPassword)).toBe(true);
  });
  it("scopes selected catalogue templates and versions in two simultaneous organization contexts", async () => {
    const org = await organization(), another = await organization(), outsider = await user();
    const template = await catalogue("selected");
    await must(admin).query("INSERT INTO app.organization_templates(organization_id,service_template_id) VALUES($1,$2)",[org.id,template.id]);
    const detail = createGetCatalogTemplateRepository(must(customer));
    const list = createListCatalogTemplatesRepository(must(customer));
    expect(await detail.findBySlug({userId:outsider.id,slug:template.slug})).toBeUndefined();
    const [visible, invisible] = await Promise.all([
      detail.findBySlug({userId:org.owner.id,tenantId:org.id,slug:template.slug}),
      detail.findBySlug({userId:another.owner.id,tenantId:another.id,slug:template.slug}),
    ]);
    expect(visible?.id).toBe(template.id); expect(invisible).toBeUndefined();
    expect((await list.list({userId:outsider.id,family:undefined,cursor:undefined,fetchLimit:101})).filter(row=>row.id===template.id)).toHaveLength(0);
    for(const [current, expected] of [[org,1],[another,0]] as const) {
      await inRole(must(customer),"dhumi_customer_api",{userId:current.owner.id,orgId:current.id},async c=> {
        expect((await c.query("SELECT id FROM app.service_templates WHERE id=$1",[template.id])).rowCount).toBe(expected);
        expect((await c.query("SELECT id FROM app.service_template_versions WHERE id=$1",[template.versionId])).rowCount).toBe(expected);
      });
      await withAdmissionOrganizationTransaction(must(admission),{userId:current.owner.id,tenantId:current.id},async db=> {
        expect((await db.query("SELECT id FROM app.service_templates WHERE id=$1",[template.id])).rowCount).toBe(expected);
      });
    }
  });
  it.each(["write_first","removal_first"] as const)("forces member removal versus an ordinary write: %s", async order=> {
    const org = await organization(), member = await join(org);
    const paused = pausedPool(must(customer),sql=> order==="write_first" ? sql.includes("FROM app.tenants")&&sql.includes("FOR SHARE") : sql.includes("UPDATE app.tenant_user_access SET access_role"));
    let writes = 0;
    const write = (p:Pool)=>withOrganizationWriteTransaction(p,{userId:member.id,tenantId:org.id},async db=> {
      await db.query("INSERT INTO app.audit_events(tenant_id,actor_user_id,action,target_type,outcome,request_id) VALUES($1,$2,'qualification.member_write','organization','success',$3)",[org.id,member.id,randomUUID()]); writes++;
    });
    const remove = (p:Pool)=>repository(must(identity),p).run("removeMember",request({}, {userId:org.owner.id,organizationId:org.id,targetId:member.id}));
    const first = order==="write_first" ? write(paused.pool) : remove(paused.pool);
    const firstObserved = first.then(()=>({ok:true}),error=>({ok:false,error}));
    let secondObserved: Promise<{ok:boolean;error?:unknown}> | undefined;
    try {
      await paused.held;
      const second = order==="write_first" ? remove(must(customer)) : write(must(customer));
      secondObserved = second.then(()=>({ok:true}),error=>({ok:false,error}));
      await blockedBy(paused.pid());
    } finally { paused.release(); }
    const firstResult = await firstObserved; if("error" in firstResult) throw firstResult.error;
    const second = await must(secondObserved);
    expect(second.ok).toBe(order==="write_first");
    if(order==="removal_first") expect(second.error).toMatchObject({status:404});
    expect(writes).toBe(order==="write_first" ? 1 : 0);
    expect((await scalar("SELECT count(*)::int n FROM app.audit_events WHERE tenant_id=$1 AND action='qualification.member_write'",[org.id])).n).toBe(writes);
    await expect(write(must(customer))).rejects.toMatchObject({status:404});
  });
  it.each(["write_first","suspension_first"] as const)("forces organization suspension versus an ordinary write: %s", async order=> {
    const org = await organization(); let writes = 0;
    const paused = pausedPool(must(customer),sql=>order==="write_first" ? sql.includes("FROM app.tenants")&&sql.includes("FOR SHARE") : sql.startsWith("UPDATE app.tenants SET state"));
    const write = (p:Pool)=>withOrganizationWriteTransaction(p,{userId:org.owner.id,tenantId:org.id},async db=> {
      await db.query("INSERT INTO app.audit_events(tenant_id,actor_user_id,action,target_type,outcome,request_id) VALUES($1,$2,'qualification.before_suspension','organization','success',$3)",[org.id,org.owner.id,randomUUID()]); writes++;
    });
    const suspend = (p:Pool)=>withOrganizationAdministrationTransaction(p,{userId:org.owner.id,tenantId:org.id},async db=> {
      await db.query("UPDATE app.tenants SET state='suspended' WHERE id=$1",[org.id]);
    });
    const first = (order==="write_first" ? write(paused.pool) : suspend(paused.pool)).then(()=>({ok:true}),error=>({ok:false,error}));
    let second: Promise<{ok:boolean;error?:unknown}> | undefined;
    try {
      await paused.held;
      second = (order==="write_first" ? suspend(must(customer)) : write(must(customer))).then(()=>({ok:true}),error=>({ok:false,error}));
      await blockedBy(paused.pid());
    } finally { paused.release(); }
    const firstResult = await first; if("error" in firstResult) throw firstResult.error;
    const later = await must(second); expect(later.ok).toBe(order==="write_first");
    if(order==="suspension_first") expect(later.error).toMatchObject({status:404});
    expect(writes).toBe(order==="write_first" ? 1 : 0);
    await expect(write(must(customer))).rejects.toMatchObject({status:404});
  });
  it.each(["changeMember","removeMember"] as const)("serializes two concurrent administrator departures and preserves the last admin: %s", async action=> {
    const org = await organization(), a = await join(org,await user(),{role:"admin"}), b = await join(org,await user(),{role:"admin"});
    await repository().run("changeMember",request({role:"member"},{userId:org.owner.id,organizationId:org.id,targetId:org.owner.id}));
    const paused = pausedPool(must(customer),sql=>sql.includes("UPDATE app.tenant_user_access SET access_role"));
    const departure = (who:TestUser,p:Pool)=>repository(must(identity),p).run(action,request({role:"member"},{userId:who.id,organizationId:org.id,targetId:who.id}));
    const first = departure(a,paused.pool).then(()=>({ok:true}),error=>({ok:false,error}));
    let second: Promise<{ok:boolean;error?:unknown}> | undefined;
    try { await paused.held; second=departure(b,must(customer)).then(()=>({ok:true}),error=>({ok:false,error})); await blockedBy(paused.pid()); }
    finally { paused.release(); }
    expect(await first).toEqual({ok:true});
    expect(await must(second)).toMatchObject({ok:false,error:{status:409}});
    expect((await scalar("SELECT count(*)::int n FROM app.tenant_user_access WHERE tenant_id=$1 AND state='active' AND access_role='admin'",[org.id])).n).toBe(1);
  });
  it("serializes two confirmations for the final invite use and creates exactly one membership", async ()=> {
    const org=await organization(), a=await user(), b=await user(), invitation=await invite(org,{max_uses:1});
    const pendingA=await repository().run("acceptInvite",request({join_code:invitation.token},{userId:a.id}));
    const pendingB=await repository().run("acceptInvite",request({join_code:invitation.token},{userId:b.id}));
    const paused=pausedPool(must(identity),sql=>sql.includes("FROM app.tenants")&&sql.includes("FOR UPDATE"));
    const confirming=(who:TestUser,pending:WorkflowResult,p:Pool)=>repository(p).run("confirmVerification",request({code:code(pending)},{userId:who.id,verificationId:verificationId(pending)}));
    const first=confirming(a,pendingA,paused.pool).then(()=>({ok:true}),error=>({ok:false,error}));
    let second:Promise<{ok:boolean;error?:unknown}>|undefined;
    try { await paused.held; second=confirming(b,pendingB,must(identity)).then(()=>({ok:true}),error=>({ok:false,error})); await blockedBy(paused.pid()); }
    finally { paused.release(); }
    expect(await first).toEqual({ok:true}); expect(await must(second)).toMatchObject({ok:false,error:{status:409}});
    expect((await scalar("SELECT use_count FROM app.organization_invites WHERE id=$1",[invitation.id])).use_count).toBe(1);
    expect((await scalar("SELECT count(*)::int n FROM app.tenant_user_access WHERE tenant_id=$1 AND user_id=ANY($2::uuid[])",[org.id,[a.id,b.id]])).n).toBe(1);
  });
  it.each(["reset_first","refresh_first","logout_first","reset_before_logout"] as const)("serializes reset with real session-family writers: %s",async order=> {
    const who=await user(), family=await session(who);
    const pending=await repository().run("passwordReset",request({email:who.email}));
    const newHash=await hash("Reset-"+randomUUID(),{memoryCost:8192,timeCost:1,parallelism:1});
    const logout=order.includes("logout"), resetFirst=order==="reset_first"||order==="reset_before_logout";
    const paused=pausedPool(must(identity),sql=>logout ? sql.includes("FROM app.auth_sessions")&&sql.includes("FOR UPDATE") : sql.includes("FROM app.users")&&sql.includes("FOR NO KEY UPDATE"));
    const reset=(p:Pool)=>repository(p).run("confirmVerification",request({code:code(pending),new_password:"isolated-test-only"},{verificationId:verificationId(pending),passwordHash:newHash}));
    const other=(p:Pool)=>logout ? createLogoutRepository(p).revoke({userId:who.id,sessionId:family.id,requestId:randomUUID(),ipFingerprint:null}) : createRefreshRepository(p).rotate({expectedSessionId:family.id,presentedTokenHash:family.tokenHash,replacementTokenHash:digest(key()),requestId:randomUUID(),ipFingerprint:null});
    const first=(resetFirst?reset(paused.pool):other(paused.pool)).then(result=>({ok:true,result}),error=>({ok:false,error}));
    let second:Promise<{ok:boolean;result?:unknown;error?:unknown}>|undefined;
    try { await paused.held; second=(resetFirst?other(must(identity)):reset(must(identity))).then(result=>({ok:true,result}),error=>({ok:false,error})); await blockedBy(paused.pid()); }
    finally { paused.release(); }
    expect((await first).ok).toBe(true); const after=await must(second); expect(after.ok).toBe(true);
    if(order==="reset_first") expect(after.result).toMatchObject({kind:"session_unavailable"});
    if(order==="reset_before_logout") expect(after.result).toBe("already_revoked");
    expect((await scalar("SELECT state FROM app.auth_sessions WHERE id=$1",[family.id])).state).toBe("revoked");
    expect((await scalar("SELECT count(*)::int n FROM app.auth_refresh_tokens WHERE session_id=$1 AND(state='active' OR ended_at IS NULL)",[family.id])).n).toBe(0);
    expect((await scalar("SELECT password_hash FROM app.users WHERE id=$1",[who.id])).password_hash).toBe(newHash);
  });
  it("permits identity's proof-bound row locks while rejecting direct tenant/active-membership mutation",async ()=> {
    const org=await organization(), member=await join(org);
    await must(admin).query("UPDATE app.email_verifications SET created_at=created_at-interval '61 seconds',expires_at=expires_at-interval '61 seconds' WHERE user_id=$1",[member.id]);
    const invitation=await invite(org,{role:"admin"});
    const pending=await repository().run("acceptInvite",request({join_code:invitation.token},{userId:member.id}));
    await inRole(must(identity),"dhumi_identity",{userId:member.id,orgId:org.id,proofId:verificationId(pending),tokenHash:digest(invitation.token).toString("hex")},async c=> {
      expect((await c.query("SELECT id FROM app.tenants WHERE id=$1 FOR UPDATE",[org.id])).rowCount).toBe(1);
      expect((await c.query("SELECT user_id FROM app.tenant_user_access WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE",[org.id,member.id])).rowCount).toBe(1);
      await denied(c,"UPDATE app.tenants SET id=id WHERE id=$1",[org.id]);
      await denied(c,"UPDATE app.tenant_user_access SET access_role='admin' WHERE tenant_id=$1 AND user_id=$2",[org.id,member.id]);
      await denied(c,"UPDATE app.email_verifications SET created_at=clock_timestamp() WHERE id=$1",[verificationId(pending)]);
      await denied(c,"UPDATE app.email_verifications SET code_hash=$2 WHERE id=$1",[verificationId(pending),digest("replacement")]);
      await denied(c,"UPDATE app.audit_events SET outcome='rewritten' WHERE actor_user_id=$1",[member.id]);
      await denied(c,"DELETE FROM app.legal_acceptances WHERE user_id=$1",[member.id]);
    });
    await inRole(must(identity),"dhumi_identity",{userId:member.id,orgId:org.id,tokenHash:digest(invitation.token).toString("hex")},async c=> {
      expect((await c.query("SELECT id FROM app.tenants WHERE id=$1 FOR UPDATE",[org.id])).rowCount).toBe(0);
    });
  });
  it("job-manager cleanup can delete only proofs expired for over 24 hours, without reading payloads",async ()=> {
    const who=await user(), old=await repository().run("createOrganization",request({name:"Old isolated challenge"},{userId:who.id}));
    await must(admin).query("UPDATE app.email_verifications SET created_at=created_at-interval '25 hours',expires_at=expires_at-interval '25 hours' WHERE id=$1",[verificationId(old)]);
    const recent=await repository().run("createOrganization",request({name:"Recent isolated challenge"},{userId:who.id}));
    await inRole(must(jobManager),"dhumi_job_manager",{},async c=> {
      expect((await c.query("SELECT id FROM app.email_verifications WHERE id=ANY($1::uuid[])",[[verificationId(old),verificationId(recent)]])).rowCount).toBe(1);
      await denied(c,"SELECT payload FROM app.email_verifications");
      expect((await c.query("DELETE FROM app.email_verifications WHERE id=ANY($1::uuid[]) RETURNING id",[[verificationId(old),verificationId(recent)]])).rows).toEqual([{id:verificationId(old)}]);
    });
    expect((await scalar("SELECT count(*)::int n FROM app.email_verifications WHERE id=ANY($1::uuid[])",[[verificationId(old),verificationId(recent)]])).n).toBe(2);
  });
  it("requires fresh proof for a second organization despite an already verified email",async ()=> {
    const who=await user(), first=await organization(who), second=await organization();
    await must(admin).query("UPDATE app.email_verifications SET created_at=created_at-interval '61 seconds',expires_at=expires_at-interval '61 seconds' WHERE user_id=$1",[who.id]);
    const invitation=await invite(second);
    const pending=await repository().run("acceptInvite",request({join_code:invitation.token},{userId:who.id}));
    expect((await scalar("SELECT count(*)::int n FROM app.tenant_user_access WHERE user_id=$1 AND state='active'",[who.id])).n).toBe(1);
    await confirm(who,pending);
    const listed=await repository().run("listOrganizations",request({}, {userId:who.id}));
    expect((listed.response.organizations as {id:string}[]).map(row=>row.id).sort()).toEqual([first.id,second.id].sort());
    const contexts=await Promise.all([first,second].map(org=>withOrganizationWriteTransaction(must(customer),{userId:who.id,tenantId:org.id},async db=> {
      const result=await db.query("SELECT id FROM app.tenants WHERE id=ANY($1::uuid[])",[[first.id,second.id]]);
      return result.rows;
    })));
    expect(contexts).toEqual([[{id:first.id}],[{id:second.id}]]);
  });
  it("binds email invitations to the recipient and rejects revoked, rotated and exhausted proofs",async ()=> {
    const org=await organization(), who=await user(), other=await user();
    const emailInvite=await invite(org,{email:who.email});
    await expect(repository().run("acceptInvite",request({invite_token:emailInvite.token},{userId:other.id}))).rejects.toMatchObject({status:409});
    const pending=await repository().run("acceptInvite",request({invite_token:emailInvite.token},{userId:who.id}));
    expect((await scalar("SELECT count(*)::int n FROM app.tenant_user_access WHERE tenant_id=$1 AND user_id=$2",[org.id,who.id])).n).toBe(0);
    await repository().run("revokeInvite",request({}, {userId:org.owner.id,organizationId:org.id,targetId:emailInvite.id}));
    await expect(confirm(who,pending)).rejects.toMatchObject({status:409});
    const rotatedUser=await user(), rotatedInvite=await invite(org);
    const rotatedProof=await repository().run("acceptInvite",request({join_code:rotatedInvite.token},{userId:rotatedUser.id}));
    await repository().run("resendInvite",request({}, {userId:org.owner.id,organizationId:org.id,targetId:rotatedInvite.id}));
    await expect(confirm(rotatedUser,rotatedProof)).rejects.toMatchObject({status:409});
    expect((await scalar("SELECT count(*)::int n FROM app.tenant_user_access WHERE tenant_id=$1 AND user_id=ANY($2::uuid[])",[org.id,[who.id,rotatedUser.id]])).n).toBe(0);
  });
  it("resends with seven days, rotates the token once, and preserves expiry on idempotent replay",async ()=> {
    const org=await organization();
    const explicitExpiry=new Date(Date.now()+3_600_000).toISOString();
    const invitation=await invite(org,{expires_at:explicitExpiry});
    expect((await scalar("SELECT expires_at FROM app.organization_invites WHERE id=$1",[invitation.id])).expires_at.toISOString()).toBe(explicitExpiry);
    const input=request({}, {userId:org.owner.id,organizationId:org.id,targetId:invitation.id});
    const before=(await scalar("SELECT clock_timestamp() now")).now.getTime();
    const result=await repository().run("resendInvite",input);
    const after=(await scalar("SELECT clock_timestamp() now")).now.getTime();
    const row=await scalar("SELECT expires_at,token_hash,use_count FROM app.organization_invites WHERE id=$1",[invitation.id]);
    expect(row.expires_at.getTime()).toBeGreaterThanOrEqual(before+7*86_400_000);
    expect(row.expires_at.getTime()).toBeLessThanOrEqual(after+7*86_400_000);
    expect(row.token_hash).toEqual(digest(String(result.response.join_code)));
    expect(row.token_hash).not.toEqual(digest(invitation.token));
    expect(row.use_count).toBe(0);
    const replay=await repository().run("resendInvite",input);
    expect(replay.response.invite).toEqual((await scalar("SELECT response_body FROM app.idempotency_records WHERE operation_code='resendInvite' AND idempotency_key=$1",[input.key])).response_body.invite);
    expect(replay.response).not.toHaveProperty("join_code");
    expect(replay.mail).toBeUndefined();
    expect(await scalar("SELECT expires_at,token_hash,use_count FROM app.organization_invites WHERE id=$1",[invitation.id])).toEqual(row);
    expect((await scalar("SELECT response_status FROM app.idempotency_records WHERE operation_code='resendInvite' AND idempotency_key=$1",[input.key])).response_status).toBe(202);
    expect((await scalar("SELECT count(*)::int n FROM app.audit_events WHERE target_id=$1 AND action='organization.resendInvite'",[invitation.id])).n).toBe(1);
  });
  it("uses an editable resend lifetime and never shortens an already later expiry",async ()=> {
    const org=await organization();
    const shorter=await invite(org);
    const configured=repository(must(identity),must(customer),loadOrganizationInviteResendLifetimeDays({ORGANIZATION_INVITE_RESEND_LIFETIME_DAYS:"3"}));
    const before=(await scalar("SELECT clock_timestamp() now")).now.getTime();
    await configured.run("resendInvite",request({}, {userId:org.owner.id,organizationId:org.id,targetId:shorter.id}));
    const after=(await scalar("SELECT clock_timestamp() now")).now.getTime();
    const changed=(await scalar("SELECT expires_at FROM app.organization_invites WHERE id=$1",[shorter.id])).expires_at.getTime();
    expect(changed).toBeGreaterThanOrEqual(before+3*86_400_000);
    expect(changed).toBeLessThanOrEqual(after+3*86_400_000);
    const laterExpiry=new Date(Date.now()+30*86_400_000).toISOString();
    const later=await invite(org,{expires_at:laterExpiry});
    await configured.run("resendInvite",request({}, {userId:org.owner.id,organizationId:org.id,targetId:later.id}));
    expect((await scalar("SELECT expires_at FROM app.organization_invites WHERE id=$1",[later.id])).expires_at.toISOString()).toBe(laterExpiry);
  });
  it.each(["expired","revoked","exhausted"])("resend does not revive an %s invitation",async state=> {
    const org=await organization();
    const invitation=await invite(org,{max_uses:1});
    if(state==="expired") await must(admin).query("UPDATE app.organization_invites SET created_at=created_at-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' WHERE id=$1",[invitation.id]);
    if(state==="revoked") await repository().run("revokeInvite",request({}, {userId:org.owner.id,organizationId:org.id,targetId:invitation.id}));
    if(state==="exhausted") await must(admin).query("UPDATE app.organization_invites SET use_count=1 WHERE id=$1",[invitation.id]);
    const before=await scalar("SELECT to_jsonb(i) value FROM app.organization_invites i WHERE id=$1",[invitation.id]);
    await expect(repository().run("resendInvite",request({}, {userId:org.owner.id,organizationId:org.id,targetId:invitation.id}))).rejects.toMatchObject({status:409});
    expect(await scalar("SELECT to_jsonb(i) value FROM app.organization_invites i WHERE id=$1",[invitation.id])).toEqual(before);
    expect((await scalar("SELECT count(*)::int n FROM app.audit_events WHERE target_id=$1 AND action='organization.resendInvite'",[invitation.id])).n).toBe(0);
  });
  it("issues once under concurrent requests, invalidates old code/link on resend, and enforces the hourly cap",async ()=> {
    const who=await user();
    const issues=await Promise.allSettled(["A","B"].map(name=>repository().run("createOrganization",request({name},{userId:who.id}))));
    expect(issues.filter(result=>result.status==="fulfilled")).toHaveLength(1);
    const rejected=issues.find(result=>result.status==="rejected"); expect(rejected).toMatchObject({status:"rejected",reason:{status:429}});
    const issued=issues.find(result=>result.status==="fulfilled"); if(issued?.status!=="fulfilled") throw Error("Missing challenge");
    await must(admin).query("UPDATE app.email_verifications SET created_at=created_at-interval '61 seconds',expires_at=expires_at-interval '61 seconds' WHERE user_id=$1",[who.id]);
    const resent=await repository().run("resendVerification",request({}, {userId:who.id,verificationId:verificationId(issued.value)}));
    const link=issued.value.mail?.text.match(/email_link_token=([^\s]+)/)?.[1]; expect(link).toBeTruthy();
    await expect(confirm(who,issued.value)).rejects.toMatchObject({status:409});
    await expect(confirm(who,issued.value,{body:{email_link_token:link}})).rejects.toMatchObject({status:409});
    const newLink=resent.mail?.text.match(/email_link_token=([^\s]+)/)?.[1];
    await confirm(who,resent,{body:{email_link_token:newLink}});
    await expect(confirm(who,resent)).rejects.toMatchObject({status:409});
    for(let count=2;count<5;count++) {
      await must(admin).query("UPDATE app.email_verifications SET created_at=created_at-interval '61 seconds',expires_at=expires_at-interval '61 seconds' WHERE user_id=$1",[who.id]);
      await repository().run("createOrganization",request({name:"Hourly cap "+count},{userId:who.id}));
    }
    await must(admin).query("UPDATE app.email_verifications SET created_at=created_at-interval '61 seconds',expires_at=expires_at-interval '61 seconds' WHERE user_id=$1",[who.id]);
    await expect(repository().run("createOrganization",request({name:"Sixth attempt"},{userId:who.id}))).rejects.toMatchObject({status:429});
    expect((await scalar("SELECT count(*)::int n FROM app.email_verifications WHERE user_id=$1",[who.id])).n).toBe(5);
  });
  it("rechecks proof expiry after a real organization lock wait",async ()=> {
    const org=await organization(), who=await user(), invitation=await invite(org);
    const pending=await repository().run("acceptInvite",request({join_code:invitation.token},{userId:who.id}));
    await must(admin).query("UPDATE app.email_verifications SET created_at=clock_timestamp()-interval '9 minutes',expires_at=clock_timestamp()+interval '800 milliseconds' WHERE id=$1",[verificationId(pending)]);
    await must(admin).query("BEGIN");
    let outcome:Promise<{ok:boolean;error?:unknown}>|undefined;
    try {
      await must(admin).query("SELECT id FROM app.tenants WHERE id=$1 FOR UPDATE",[org.id]);
      const pid=(await scalar("SELECT pg_backend_pid() pid")).pid;
      outcome=confirm(who,pending).then(()=>({ok:true}),error=>({ok:false,error}));
      await blockedBy(pid); await must(admin).query("SELECT pg_sleep(1)");
    } finally { await must(admin).query("ROLLBACK"); }
    expect(await must(outcome)).toMatchObject({ok:false,error:{status:409}});
    expect((await scalar("SELECT count(*)::int n FROM app.tenant_user_access WHERE tenant_id=$1 AND user_id=$2",[org.id,who.id])).n).toBe(0);
  });
  it("all eight retained logins authenticate without inheriting owner privileges or escaping to owner",async ()=> {
    const names=Object.keys(env).filter(name=>/^DATABASE_[A-Z_]+_USER$/.test(name));
    expect(names).toHaveLength(8);
    for(const field of names) {
      const p=pool(field.slice(9,-5));
      const c=await p.connect();
      try {
        await c.query("BEGIN");
        const profile=(await c.query("SELECT current_user name,rolsuper,rolinherit,rolbypassrls,pg_has_role(current_user,'dhumi_owner','SET') owner_set FROM pg_roles WHERE rolname=current_user")).rows[0];
        expect(profile).toEqual({name:env[field],rolsuper:false,rolinherit:false,rolbypassrls:false,owner_set:false});
        await denied(c,"SET LOCAL ROLE dhumi_owner");
        await denied(c,"SELECT password_hash FROM app.users");
      } finally {await c.query("ROLLBACK");c.release();await p.end();}
    }
  });
  it.each(["reset_first","signin_first"] as const)("serializes password reset with verified-password sign-in: %s",async order=> {
    const who=await user(), pending=await repository().run("passwordReset",request({email:who.email}));
    const newHash=await hash("New-isolated-password-"+randomUUID(),{memoryCost:8192,timeCost:1,parallelism:1});
    const paused=pausedPool(must(identity),sql=>sql.includes("FROM app.users")&&sql.includes("FOR NO KEY UPDATE"));
    const reset=(p:Pool)=>repository(p).run("confirmVerification",request({code:code(pending),new_password:"new-isolated-password"},{verificationId:verificationId(pending),passwordHash:newHash}));
    const signin=(p:Pool)=>createSignInRepository(p).createSession({userId:who.id,tokenFamilyHash:digest(key()),expiresAt:new Date(Date.now()+3_600_000)},
      {tenantId:null,actorUserId:who.id,action:"identity.signin",outcome:"success",requestId:randomUUID(),ipFingerprint:null},
      {verifiedPasswordHash:who.passwordHash,allowExpiredLock:false,lockoutWindowMs:60000});
    const resetFirst=order==="reset_first";
    const first=(resetFirst?reset(paused.pool):signin(paused.pool)).then(result=>({ok:true,result}),error=>({ok:false,error}));
    let second:Promise<{ok:boolean;result?:unknown;error?:unknown}>|undefined;
    try { await paused.held;second=(resetFirst?signin(must(identity)):reset(must(identity))).then(result=>({ok:true,result}),error=>({ok:false,error}));await blockedBy(paused.pid()); }
    finally {paused.release();}
    expect((await first).ok).toBe(true);const later=await must(second);expect(later.ok).toBe(true);
    if(resetFirst) expect(later.result).toMatchObject({kind:"identity_unavailable"});
    expect((await scalar("SELECT count(*)::int n FROM app.auth_sessions WHERE user_id=$1 AND state='active'",[who.id])).n).toBe(0);
    expect((await scalar("SELECT count(*)::int n FROM app.auth_sessions WHERE user_id=$1",[who.id])).n).toBe(resetFirst?0:1);
  });
  it.each(["resend_first","confirmation_first"] as const)("serializes resend against code/link confirmation without a second activation: %s",async order=> {
    const who=await user(), pending=await repository().run("createOrganization",request({name:"Resend race"},{userId:who.id}));
    await must(admin).query("UPDATE app.email_verifications SET created_at=created_at-interval '61 seconds',expires_at=expires_at-interval '61 seconds' WHERE user_id=$1",[who.id]);
    const paused=pausedPool(must(identity),sql=>sql.includes("FROM app.users")&&sql.includes("FOR NO KEY UPDATE"));
    const resend=(p:Pool)=>repository(p).run("resendVerification",request({}, {userId:who.id,verificationId:verificationId(pending)}));
    const confirmation=(p:Pool)=>repository(p).run("confirmVerification",request({code:code(pending)},{userId:who.id,verificationId:verificationId(pending)}));
    const resendFirst=order==="resend_first";
    const first=(resendFirst?resend(paused.pool):confirmation(paused.pool)).then(()=>({ok:true}),error=>({ok:false,error}));
    let second:Promise<{ok:boolean;error?:unknown}>|undefined;
    try {await paused.held;second=(resendFirst?confirmation(must(identity)):resend(must(identity))).then(()=>({ok:true}),error=>({ok:false,error}));await blockedBy(paused.pid());}
    finally {paused.release();}
    expect(await first).toEqual({ok:true});expect(await must(second)).toMatchObject({ok:false,error:{status:409}});
    expect((await scalar("SELECT count(*)::int n FROM app.tenants WHERE created_by_user_id=$1",[who.id])).n).toBe(resendFirst?0:1);
    expect((await scalar("SELECT count(*)::int n FROM app.email_verifications WHERE user_id=$1 AND consumed_at IS NULL",[who.id])).n).toBe(resendFirst?1:0);
  });
  it.each(["rotation_first","join_first"] as const)("serializes invitation rotation versus a fresh join: %s",async order=> {
    const org=await organization(), who=await user(), invitation=await invite(org);
    const pending=await repository().run("acceptInvite",request({join_code:invitation.token},{userId:who.id}));
    const rotationFirst=order==="rotation_first";
    const paused=pausedPool(rotationFirst?must(customer):must(identity),sql=>sql.includes("FROM app.tenants")&&sql.includes("FOR UPDATE"));
    const rotate=(p:Pool)=>repository(must(identity),p).run("resendInvite",request({}, {userId:org.owner.id,organizationId:org.id,targetId:invitation.id}));
    const joining=(p:Pool)=>repository(p).run("confirmVerification",request({code:code(pending)},{userId:who.id,verificationId:verificationId(pending)}));
    const first=(rotationFirst?rotate(paused.pool):joining(paused.pool)).then(()=>({ok:true}),error=>({ok:false,error}));
    let second:Promise<{ok:boolean;error?:unknown}>|undefined;
    try {await paused.held;second=(rotationFirst?joining(must(identity)):rotate(must(customer))).then(()=>({ok:true}),error=>({ok:false,error}));await blockedBy(paused.pid());}
    finally {paused.release();}
    expect(await first).toEqual({ok:true});const later=await must(second);expect(later.ok).toBe(!rotationFirst);
    if(rotationFirst) expect(later.error).toMatchObject({status:409});
    expect((await scalar("SELECT count(*)::int n FROM app.tenant_user_access WHERE tenant_id=$1 AND user_id=$2",[org.id,who.id])).n).toBe(rotationFirst?0:1);
    expect((await scalar("SELECT use_count FROM app.organization_invites WHERE id=$1",[invitation.id])).use_count).toBe(rotationFirst?0:1);
  });
  it("NO KEY UPDATE admits admin invitation FK checks while the same user waits on the organization",async ()=> {
    const org=await organization(), who=await join(org,await user(),{role:"admin"});
    await must(admin).query("UPDATE app.email_verifications SET created_at=created_at-interval '61 seconds',expires_at=expires_at-interval '61 seconds' WHERE user_id=$1",[who.id]);
    const invitation=await invite(org), pending=await repository().run("acceptInvite",request({join_code:invitation.token},{userId:who.id}));
    const paused=pausedPool(must(customer),sql=>sql.includes("FROM app.tenant_user_access")&&sql.includes("ORDER BY user_id FOR UPDATE"));
    const administrative=repository(must(identity),paused.pool).run("createInvite",request({role:"member",expires_at:new Date(Date.now()+3_600_000).toISOString()}, {userId:who.id,organizationId:org.id})).then(()=>({ok:true}),error=>({ok:false,error}));
    let joining:Promise<{ok:boolean;error?:unknown}>|undefined;
    try {await paused.held;joining=confirm(who,pending).then(()=>({ok:true}),error=>({ok:false,error}));await blockedBy(paused.pid());}
    finally {paused.release();}
    expect(await administrative).toEqual({ok:true});expect(await must(joining)).toEqual({ok:true});
    expect((await scalar("SELECT use_count FROM app.organization_invites WHERE id=$1",[invitation.id])).use_count).toBe(0);
  });
  it("rechecks reset expiry after a session lock wait and leaves credentials/sessions unchanged",async ()=> {
    const who=await user(), family=await session(who), pending=await repository().run("passwordReset",request({email:who.email}));
    await must(admin).query("UPDATE app.email_verifications SET created_at=clock_timestamp()-interval '9 minutes',expires_at=clock_timestamp()+interval '800 milliseconds' WHERE id=$1",[verificationId(pending)]);
    await must(admin).query("BEGIN");let outcome:Promise<{ok:boolean;error?:unknown}>|undefined;
    try {
      await must(admin).query("SELECT id FROM app.auth_sessions WHERE id=$1 FOR UPDATE",[family.id]);
      const pid=(await scalar("SELECT pg_backend_pid() pid")).pid;
      outcome=repository().run("confirmVerification",request({code:code(pending),new_password:"not-committed"},{verificationId:verificationId(pending),passwordHash:"not-committed"})).then(()=>({ok:true}),error=>({ok:false,error}));
      await blockedBy(pid);await must(admin).query("SELECT pg_sleep(1)");
    } finally {await must(admin).query("ROLLBACK");}
    expect(await must(outcome)).toMatchObject({ok:false,error:{status:409}});
    expect((await scalar("SELECT password_hash FROM app.users WHERE id=$1",[who.id])).password_hash).toBe(who.passwordHash);
    expect((await scalar("SELECT state FROM app.auth_sessions WHERE id=$1",[family.id])).state).toBe("active");
  });
});
