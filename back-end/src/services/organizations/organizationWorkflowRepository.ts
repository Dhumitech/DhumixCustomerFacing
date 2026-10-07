import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { DatabaseExecutor } from "../../types/database.js";
import { ApplicationError } from "../../utils/applicationError.js";
import { withIdentityTransaction, withIdentityUserTransaction, withOrganizationReadTransaction, withOrganizationAdministrationTransaction } from "../database/transactions.js";
import { revokeSessionFamily } from "../identity/sessionRevocation.js";
import { assertMemberChange, codeHash, digest, equalDigest, secretToken, verificationCode, workflowConflict } from "./organizationSecurity.js";
import type { OrganizationRole, VerificationPurpose } from "./organizationSecurity.js";
import { claimWorkflow, completeWorkflow } from "./workflowIdempotency.js";
import type { WorkflowResponse } from "./workflowIdempotency.js";
import { verificationMail } from "./verificationEmail.js";
import type { WorkflowMail } from "./verificationEmail.js";

export type OrganizationAction = "listOrganizations" | "createOrganization" | "acceptInvite" | "passwordReset" |
  "confirmVerification" | "resendVerification" | "listMembers" | "changeMember" | "removeMember" |
  "listInvites" | "createInvite" | "revokeInvite" | "resendInvite";
export interface WorkflowRequest {
  userId?: string; organizationId?: string; targetId?: string; verificationId?: string;
  body: Record<string, unknown>; key: string; traceId: string; passwordHash?: string;
}
export interface WorkflowResult { response: WorkflowResponse; mail?: WorkflowMail; failure?: ApplicationError }
export interface OrganizationWorkflowRepository { run(action: OrganizationAction, input: WorkflowRequest): Promise<WorkflowResult> }
interface UserRow { id: string; email_normalized: string; state: string }
interface VerificationRow {
  id: string; user_id: string; purpose: VerificationPurpose; code_hash: Buffer;
  payload: Record<string, unknown> | null; attempt_count: number; consumed_at: Date | null; usable: boolean;
}
interface InviteRow {
  id: string; organization_id: string; email: string | null; token_hash: Buffer; role: OrganizationRole;
  max_uses: number | null; use_count: number; usable: boolean;
}
interface MemberRow { user_id: string; role: OrganizationRole; state: string }

const accepted = (id: string): WorkflowResponse => ({ accepted: true, verification_id: id });
const forbidden = (): ApplicationError => new ApplicationError({ status: 403, code: "ACCESS_DENIED", title: "Access denied" });
const limit = (): ApplicationError => new ApplicationError({ status: 429, code: "PLATFORM_CAPACITY_LIMIT", title: "Wait before requesting another verification" });
async function audit(db: DatabaseExecutor, input: WorkflowRequest, action: string, type: string, id: string, organizationId?: string): Promise<void> {
  await db.query(`INSERT INTO app.audit_events (organization_id, actor_user_id, action, target_type, target_id, outcome, trace_id)
    VALUES ($1, $2, $3, $4, $5, 'success', $6)`, [organizationId ?? null, input.userId ?? null, action, type, id, input.traceId]);
}
async function bindVerification(db: DatabaseExecutor, id: string): Promise<void> {
  await db.query("SELECT set_config('app.verification_id', $1, true)", [id]);
}
async function lockUser(db: DatabaseExecutor, id: string): Promise<UserRow> {
  // The key is immutable. This serializes identity writers while admitting
  // FK KEY SHARE checks from organization administration (no user/org cycle).
  const result = await db.query<UserRow>("SELECT id, email_normalized, state FROM app.users WHERE id = $1 FOR NO KEY UPDATE", [id]);
  const user = result.rows[0];
  if (!user || (user.state !== "active" && user.state !== "locked")) throw forbidden();
  return user;
}
async function readVerification(db: DatabaseExecutor, id: string, locked: boolean): Promise<VerificationRow | undefined> {
  const result = await db.query<VerificationRow>(`SELECT id, user_id, purpose, code_hash, payload, attempt_count, consumed_at,
    (consumed_at IS NULL AND expires_at > clock_timestamp() AND attempt_count < 5) AS usable
    FROM app.email_verifications WHERE id = $1 ${locked ? "FOR UPDATE" : ""}`, [id]);
  return result.rows[0];
}
async function recheckProofDeadline(db: DatabaseExecutor, id: string): Promise<void> {
  // A proof may expire while waiting for organization or session locks.
  const result = await db.query<{ fresh: boolean }>(`SELECT expires_at > clock_timestamp() AND consumed_at IS NULL AND attempt_count < 5 AS fresh
    FROM app.email_verifications WHERE id = $1`, [id]);
  if (!result.rows[0]?.fresh) throw workflowConflict();
}
async function inviteByHash(db: DatabaseExecutor, hash: Buffer): Promise<InviteRow | undefined> {
  await db.query("SELECT set_config('app.invite_token_hash', $1, true)", [hash.toString("hex")]);
  const result = await db.query<InviteRow>(`SELECT id, organization_id, email, token_hash, role, max_uses, use_count,
    (revoked_at IS NULL AND expires_at > clock_timestamp() AND (max_uses IS NULL OR use_count < max_uses)) AS usable
    FROM app.organization_invites WHERE token_hash = $1`, [hash]);
  return result.rows[0];
}
function matchesInvite(invite: InviteRow | undefined, user: UserRow): invite is InviteRow {
  return !!invite?.usable && (invite.email === null || invite.email === user.email_normalized);
}

export function createOrganizationWorkflowRepository(input: { identityPool: Pool; customerPool: Pool; otpSecret: string; publicUrl: string; inviteResendLifetimeDays: number }): OrganizationWorkflowRepository {
  const { identityPool, customerPool, otpSecret, publicUrl, inviteResendLifetimeDays } = input;
  async function issue(db: DatabaseExecutor, user: UserRow, purpose: VerificationPurpose, payload: Record<string, unknown>, traceId: string): Promise<WorkflowResult> {
    // The user lock serializes issuance across every purpose and every API instance.
    const usage = await db.query<{ count: number; cooling: boolean }>(`SELECT count(*)::int AS count,
      COALESCE(max(created_at) > clock_timestamp() - interval '60 seconds', false) AS cooling
      FROM app.email_verifications WHERE user_id = $1 AND created_at > clock_timestamp() - interval '1 hour'`, [user.id]);
    if ((usage.rows[0]?.count ?? 5) >= 5 || usage.rows[0]?.cooling) throw limit();
    const id = randomUUID();
    const code = verificationCode();
    const token = purpose === "password_reset" ? undefined : secretToken();
    const pending = { ...payload, email: user.email_normalized, ...(token ? { email_link_hash: digest(token).toString("hex") } : {}) };
    // Same action only. A resend never revives the old code or link.
    await db.query(`UPDATE app.email_verifications SET consumed_at = clock_timestamp(), payload = NULL
      WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL
        AND (payload ->> 'organization_name') IS NOT DISTINCT FROM $3::text
        AND (payload ->> 'invite_id') IS NOT DISTINCT FROM $4::text`,
      [user.id, purpose, payload.organization_name ?? null, payload.invite_id ?? null]);
    await db.query(`INSERT INTO app.email_verifications (id, user_id, purpose, code_hash, payload, expires_at, trace_id)
      VALUES ($1, $2, $3, $4, $5::jsonb, clock_timestamp() + interval '10 minutes', $6)`,
      [id, user.id, purpose, codeHash(otpSecret, id, user.id, purpose, code), JSON.stringify(pending), traceId]);
    return { response: accepted(id), mail: verificationMail({ recipient: user.email_normalized, id, code, purpose, publicUrl, traceId, ...(token ? { token } : {}) }) };
  }
  async function begin(action: OrganizationAction, req: WorkflowRequest): Promise<WorkflowResult> {
    return withIdentityTransaction(identityPool, async (db) => {
      let userId = req.userId;
      const resetEmail = String(req.body.email).trim().toLowerCase();
      if (action === "passwordReset") {
        const found = await db.query<UserRow>("SELECT id, email_normalized, state FROM app.users WHERE email_normalized = $1", [resetEmail]);
        userId = found.rows[0]?.id;
        // Unknown/disabled accounts use the same response shape and never reveal state.
        if (!userId || !["active", "locked"].includes(found.rows[0]?.state ?? "")) {
          const claim = await claimWorkflow(db, { userId: `password-reset:${codeHash(otpSecret, "request", "public", "password_reset", resetEmail).toString("hex")}`,
            operation: action, key: req.key, fingerprint: { email_hash: digest(resetEmail).toString("hex") } });
          if (claim.replay) return { response: claim.replay };
          const response = accepted(randomUUID()); await completeWorkflow(db, claim.id, 202, response);
          return { response };
        }
      }
      if (!userId) throw forbidden();
      await db.query("SELECT set_config('app.user_id', $1, true)", [userId]);
      const user = await lockUser(db, userId);
      if (action !== "passwordReset" && user.state !== "active") throw forbidden();
      const safeBody = action === "acceptInvite" ? { token_hash: digest(String(req.body.join_code ?? req.body.invite_token)).toString("hex") }
        : action === "passwordReset" ? { email_hash: digest(user.email_normalized).toString("hex") } : { name: String(req.body.name).trim() };
      const claim = await claimWorkflow(db, { userId: action === "passwordReset" ? `password-reset:${codeHash(otpSecret, "request", "public", "password_reset", resetEmail).toString("hex")}` : userId,
        operation: action, key: req.key, fingerprint: safeBody });
      if (claim.replay) return { response: claim.replay };
      let payload: Record<string, unknown> = {};
      let purpose: VerificationPurpose = "password_reset";
      if (action === "createOrganization") { purpose = "create_organization"; payload = { organization_name: String(req.body.name).trim() }; }
      if (action === "acceptInvite") {
        purpose = "join_organization";
        const hash = digest(String(req.body.join_code ?? req.body.invite_token));
        const invite = await inviteByHash(db, hash);
        if (!matchesInvite(invite, user)) throw workflowConflict("Invitation unavailable");
        const org = await db.query<{ id: string }>("SELECT id FROM app.organizations WHERE id = $1 AND state = 'active'", [invite.organization_id]);
        if (!org.rows[0]) throw workflowConflict("Invitation unavailable");
        payload = { invite_id: invite.id, organization_id: invite.organization_id, invite_token_hash: hash.toString("hex") };
      }
      let result: WorkflowResult;
      try { result = await issue(db, user, purpose, payload, req.traceId); }
      catch (error) { if (action !== "passwordReset" || !(error instanceof ApplicationError) || error.status !== 429) throw error; result = { response: accepted(randomUUID()) }; }
      await completeWorkflow(db, claim.id, 202, result.response);
      return result;
    });
  }
  async function verification(action: OrganizationAction, req: WorkflowRequest): Promise<WorkflowResult> {
    return withIdentityTransaction(identityPool, async (db) => {
      const id = req.verificationId!;
      await bindVerification(db, id);
      if (req.userId) await db.query("SELECT set_config('app.user_id', $1, true)", [req.userId]);
      const discovered = await readVerification(db, id, false);
      if (!discovered) {
        if (action === "resendVerification" && !req.userId) return { response: accepted(randomUUID()) };
        throw workflowConflict();
      }
      if (discovered.purpose !== "password_reset" && discovered.user_id !== req.userId) throw forbidden();
      // User -> verification -> organization -> sorted members -> invite.
      // Administration never locks users, so it cannot reverse this order.
      const user = await lockUser(db, discovered.user_id);
      if (discovered.purpose !== "password_reset" && user.state !== "active") throw forbidden();
      await db.query("SELECT set_config('app.user_id', $1, true)", [user.id]);
      const pending = await readVerification(db, id, true);
      if (!pending) throw workflowConflict();
      if (action === "resendVerification") {
        const claim = await claimWorkflow(db, { userId: user.id, operation: action, key: req.key, fingerprint: { id } });
        if (claim.replay) return { response: claim.replay };
        const payload = pending.payload;
        if (!payload || pending.consumed_at || payload.email !== user.email_normalized) {
          if (pending.purpose !== "password_reset") throw workflowConflict();
          const response = accepted(randomUUID()); await completeWorkflow(db, claim.id, 202, response); return { response };
        }
        if (pending.purpose === "join_organization") {
          const invite = await inviteByHash(db, Buffer.from(String(payload.invite_token_hash), "hex"));
          if (!matchesInvite(invite, user) || invite.id !== payload.invite_id) throw workflowConflict("Invitation unavailable");
          const org = await db.query("SELECT id FROM app.organizations WHERE id = $1 AND state = 'active'", [invite.organization_id]);
          if (!org.rows[0]) throw workflowConflict("Invitation unavailable");
        }
        let result: WorkflowResult;
        try { const { email_link_hash: _old, ...retained } = payload; result = await issue(db, user, pending.purpose, retained, req.traceId); }
        catch (error) { if (pending.purpose !== "password_reset" || !(error instanceof ApplicationError) || error.status !== 429) throw error; result = { response: accepted(randomUUID()) }; }
        await completeWorkflow(db, claim.id, 202, result.response); return result;
      }
      const presented = typeof req.body.code === "string" ? codeHash(otpSecret, id, user.id, pending.purpose, req.body.code)
        : digest(String(req.body.email_link_token));
      const claim = await claimWorkflow(db, { userId: user.id, operation: action, key: req.key, fingerprint: { id, proof: presented.toString("hex"), kind: req.body.code ? "code" : "link",
        ...(typeof req.body.new_password === "string" ? { password: codeHash(otpSecret, id, user.id, pending.purpose, `password:${req.body.new_password}`).toString("hex") } : {}) } });
      // Completed replay requires the same bound account and proof fingerprint.
      if (claim.replay) return { response: claim.replay };
      const expected = typeof req.body.code === "string" ? pending.code_hash
        : Buffer.from(String(pending.payload?.email_link_hash ?? ""), "hex");
      if (!pending.usable || !pending.payload || pending.payload.email !== user.email_normalized) throw workflowConflict();
      if ((pending.purpose === "password_reset" && typeof req.body.code !== "string") || !equalDigest(expected, presented)) {
        await db.query(`UPDATE app.email_verifications SET attempt_count = attempt_count + 1,
          consumed_at = CASE WHEN attempt_count + 1 >= 5 THEN clock_timestamp() ELSE consumed_at END,
          payload = CASE WHEN attempt_count + 1 >= 5 THEN NULL ELSE payload END WHERE id = $1`, [id]);
        // Remove the unsuccessful claim so retrying it cannot bypass the five-attempt cap.
        // No DELETE grant is required: a failed row records this attempt; retries conflict.
        await db.query("UPDATE app.idempotency_records SET state = 'failed' WHERE id = $1", [claim.id]);
        return { response: {}, failure: workflowConflict("Verification code is invalid") };
      }
      const payload = pending.payload;
      let response: WorkflowResponse;
      if (pending.purpose === "password_reset") {
        if (!req.passwordHash) throw workflowConflict();
        // All session writers that also lock users use user -> session -> token.
        const sessions = await db.query<{ id: string }>("SELECT id FROM app.auth_sessions WHERE user_id = $1 ORDER BY id FOR UPDATE", [user.id]);
        await recheckProofDeadline(db, id);
        for (const session of sessions.rows) await revokeSessionFamily(db, session.id, "password_reset");
        await db.query(`UPDATE app.users SET password_hash = $2, failed_auth_count = 0, last_failed_auth_at = NULL,
          state = 'active', email_verified_at = COALESCE(email_verified_at, clock_timestamp()) WHERE id = $1`, [user.id, req.passwordHash]);
        await db.query("UPDATE app.email_verifications SET consumed_at = clock_timestamp(), payload = NULL WHERE user_id = $1 AND consumed_at IS NULL", [user.id]);
        await audit(db, { ...req, userId: user.id }, "identity.password_reset", "user", user.id);
        response = { confirmed: true, sign_in_required: true };
      } else {
        let organizationId: string;
        if (pending.purpose === "create_organization") {
          organizationId = randomUUID();
          await db.query("INSERT INTO app.organizations (id, name, created_by_user_id) VALUES ($1, $2, $3)", [organizationId, payload.organization_name, user.id]);
          await db.query("SELECT set_config('app.organization_id', $1, true)", [organizationId]);
          await db.query("INSERT INTO app.organization_members (organization_id, user_id, role) VALUES ($1, $2, 'admin')", [organizationId, user.id]);
        } else {
          organizationId = String(payload.organization_id);
          const hash = Buffer.from(String(payload.invite_token_hash), "hex");
          await db.query("SELECT set_config('app.invite_token_hash', $1, true), set_config('app.organization_id', $2, true)", [hash.toString("hex"), organizationId]);
          const organization = await db.query("SELECT id FROM app.organizations WHERE id = $1 AND state = 'active' FOR UPDATE", [organizationId]);
          if (!organization.rows[0]) throw workflowConflict("Invitation unavailable");
          const members = await db.query<MemberRow>("SELECT user_id, role, state FROM app.organization_members WHERE organization_id = $1 ORDER BY user_id FOR UPDATE", [organizationId]);
          const invitation = await db.query<InviteRow>(`SELECT id, organization_id, email, token_hash, role, max_uses, use_count,
            (revoked_at IS NULL AND expires_at > clock_timestamp() AND (max_uses IS NULL OR use_count < max_uses)) AS usable
            FROM app.organization_invites WHERE id = $1 AND organization_id = $2 FOR UPDATE`, [payload.invite_id, organizationId]);
          const invite = invitation.rows[0];
          if (!matchesInvite(invite, user) || !equalDigest(invite.token_hash, hash)) throw workflowConflict("Invitation unavailable");
          await recheckProofDeadline(db, id);
          const member = members.rows.find((row) => row.user_id === user.id);
          if (member?.state !== "active") {
            if (member && member.state !== "removed") throw workflowConflict();
            if (member) await db.query("UPDATE app.organization_members SET state = 'active', role = $3, invite_id = $4 WHERE organization_id = $1 AND user_id = $2", [organizationId, user.id, invite.role, invite.id]);
            else await db.query("INSERT INTO app.organization_members (organization_id, user_id, role, invite_id) VALUES ($1, $2, $3, $4)", [organizationId, user.id, invite.role, invite.id]);
            await db.query("UPDATE app.organization_invites SET use_count = use_count + 1 WHERE id = $1", [invite.id]);
          }
        }
        await db.query("UPDATE app.users SET email_verified_at = COALESCE(email_verified_at, clock_timestamp()) WHERE id = $1", [user.id]);
        await audit(db, req, pending.purpose === "create_organization" ? "organization.created" : "organization.joined", "tenant", organizationId, organizationId);
        await db.query("UPDATE app.email_verifications SET consumed_at = clock_timestamp(), payload = NULL WHERE id = $1", [id]);
        response = { confirmed: true, organization_id: organizationId };
      }
      await completeWorkflow(db, claim.id, 200, response);
      return { response };
    });
  }
  async function administration(action: OrganizationAction, req: WorkflowRequest): Promise<WorkflowResult> {
    const context = { userId: req.userId!, tenantId: req.organizationId! };
    const read = action === "listMembers" || action === "listInvites";
    const transaction = read ? withOrganizationReadTransaction : withOrganizationAdministrationTransaction;
    return transaction(customerPool, context, async (db) => {
      const members = await db.query<MemberRow>("SELECT user_id, role, state FROM app.organization_members WHERE organization_id = $1 ORDER BY user_id", [context.tenantId]);
      const caller = members.rows.find((member) => member.user_id === context.userId && member.state === "active");
      if (!caller || (action !== "listMembers" && caller.role !== "admin")) throw forbidden();
      if (action === "listMembers") {
        const result = await db.query(`SELECT m.user_id, u.email_normalized AS email, m.role AS role, m.state,
          m.created_at, (t.created_by_user_id = m.user_id) AS is_creator FROM app.organization_members m
          JOIN app.users u ON u.id = m.user_id JOIN app.organizations t ON t.id = m.organization_id
          WHERE m.organization_id = $1 ORDER BY m.created_at, m.user_id`, [context.tenantId]);
        return { response: { members: result.rows } };
      }
      if (action === "listInvites") {
        const result = await db.query(`SELECT id, email, role, max_uses, use_count, expires_at, revoked_at, created_at
          FROM app.organization_invites WHERE organization_id = $1 ORDER BY created_at DESC, id`, [context.tenantId]);
        return { response: { invites: result.rows } };
      }
      const claim = await claimWorkflow(db, { userId: context.userId, organizationId: context.tenantId, operation: action, key: req.key, fingerprint: { target: req.targetId, ...req.body } });
      if (claim.replay) return { response: claim.replay };
      let response: WorkflowResponse = { completed: true };
      let mail: WorkflowMail | undefined;
      let minted: WorkflowResponse = {};
      if (action === "changeMember" || action === "removeMember") {
        const target = members.rows.find((member) => member.user_id === req.targetId && member.state === "active");
        if (!target) throw workflowConflict("Active member not found");
        const org = await db.query<{ created_by_user_id: string }>("SELECT created_by_user_id FROM app.organizations WHERE id = $1", [context.tenantId]);
        assertMemberChange({ callerId: context.userId, creatorId: org.rows[0]!.created_by_user_id, targetId: target.user_id,
          targetRole: target.role, activeAdmins: members.rows.filter((member) => member.state === "active" && member.role === "admin").length,
          nextRole: action === "removeMember" ? target.role : req.body.role as OrganizationRole, remove: action === "removeMember" });
        await db.query("UPDATE app.organization_members SET role = $3, state = $4 WHERE organization_id = $1 AND user_id = $2", [context.tenantId, target.user_id, action === "removeMember" ? target.role : req.body.role, action === "removeMember" ? "removed" : "active"]);
        await audit(db, req, action === "removeMember" ? "organization.member_removed" : "organization.member_role_changed", "user", target.user_id, context.tenantId);
      } else {
        let id = req.targetId;
        if (action === "revokeInvite") {
          const updated = await db.query("UPDATE app.organization_invites SET revoked_at = COALESCE(revoked_at, clock_timestamp()) WHERE organization_id = $1 AND id = $2 RETURNING id", [context.tenantId, id]);
          if (!updated.rows[0]) throw workflowConflict("Invitation unavailable");
        } else {
          const token = secretToken();
          if (action === "createInvite") {
            const expiry = await db.query<{ valid: boolean }>("SELECT $1::timestamptz > clock_timestamp() AS valid", [req.body.expires_at]);
            if (!expiry.rows[0]?.valid || (req.body.email && req.body.max_uses !== undefined && req.body.max_uses !== 1))
              throw new ApplicationError({ status: 422, code: "VALIDATION_ERROR", title: "Invitations require a future expiry; email invitations allow one use" });
            id = randomUUID();
            const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : null;
            const result = await db.query(`INSERT INTO app.organization_invites (id, organization_id, email, token_hash, role, max_uses, expires_at, created_by_user_id)
              VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8)
              RETURNING id, email, role, max_uses, use_count, expires_at, revoked_at, created_at`,
              [id, context.tenantId, email, digest(token), req.body.role ?? "member", email ? 1 : req.body.max_uses ?? null, req.body.expires_at, context.userId]);
            response = { invite: result.rows[0] };
          } else {
            const result = await db.query(`UPDATE app.organization_invites SET token_hash = $3,
                expires_at = GREATEST(expires_at, clock_timestamp() + make_interval(days => $4::integer))
              WHERE organization_id = $1 AND id = $2 AND revoked_at IS NULL AND expires_at > clock_timestamp()
                AND (max_uses IS NULL OR use_count < max_uses)
              RETURNING id, email, role, max_uses, use_count, expires_at, revoked_at, created_at`, [context.tenantId, id, digest(token), inviteResendLifetimeDays]);
            if (!result.rows[0]) throw workflowConflict("Invitation unavailable");
            response = { invite: result.rows[0] };
          }
          const invite = response.invite as { email: string | null };
          const inviteUrl = `${publicUrl}/invite#invite_token=${token}`;
          minted = invite.email ? { invite_token: token, invite_url: inviteUrl } : { join_code: token };
          if (invite.email) mail = { recipient: invite.email, traceId: req.traceId, purpose: "organization_invite", subject: "Dhumi organization invitation", text: `Sign in or sign up with this email address, then open ${inviteUrl}\nJoining requires fresh email verification.` };
        }
        await audit(db, req, `organization.${action}`, "organization_invite", id!, context.tenantId);
      }
      // One-time minting output stays in memory. Replays return metadata; explicit resend rotates it.
      await completeWorkflow(db, claim.id, action === "createInvite" ? 201 : action === "resendInvite" ? 202 : 200, response);
      return { response: { ...response, ...minted }, ...(mail ? { mail } : {}) };
    });
  }
  return { async run(action, req) {
    if (action === "listOrganizations") {
      return withIdentityUserTransaction(identityPool, req.userId!, async (db) => {
        const user = await db.query("SELECT id FROM app.users WHERE id = $1 AND state = 'active'", [req.userId]);
        if (!user.rows[0]) throw forbidden();
        const result = await db.query(`SELECT t.id, t.name AS name, t.state, m.role AS role
          FROM app.organizations t JOIN app.organization_members m ON m.organization_id = t.id
          WHERE m.user_id = $1 AND m.state = 'active' AND t.state = 'active' ORDER BY t.created_at, t.id`, [req.userId]);
        return { response: { organizations: result.rows } };
      });
    }
    if (["createOrganization", "acceptInvite", "passwordReset"].includes(action)) return begin(action, req);
    if (["confirmVerification", "resendVerification"].includes(action)) return verification(action, req);
    return administration(action, req);
  } };
}
