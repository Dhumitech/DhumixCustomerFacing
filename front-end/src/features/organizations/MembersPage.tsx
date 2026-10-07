import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { organizationsApi } from "../../api/organizations";
import { selectedOrganization } from "../../api/organizationScope";
import { useSession } from "../../session/useSession";
import { useWorkspaceQuery } from "../workspace/workspaceQueries";

export function MembersPage() {
  const { identityEmail } = useSession();
  const id = selectedOrganization();
  const queries = useQueryClient();
  const workspace = useWorkspaceQuery();
  const admin = workspace.data?.role === "admin";
  const members = useQuery({ queryKey: ["members", identityEmail, id], queryFn: organizationsApi.members, enabled: !!id });
  const invites = useQuery({ queryKey: ["invites", identityEmail, id], queryFn: organizationsApi.invites, enabled: !!id && admin });
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [expires, setExpires] = useState("");
  const [maxUses, setMaxUses] = useState("");
  const [minted, setMinted] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function perform(work: () => Promise<unknown>) {
    setError(null); setBusy(true);
    try { await work(); await queries.invalidateQueries({ queryKey: ["members"] }); await queries.invalidateQueries({ queryKey: ["invites"] }); await queries.invalidateQueries({ queryKey: ["workspace"] }); }
    catch { setError("This action could not be completed. The creator and last administrator are protected."); }
    finally { setBusy(false); }
  }
  if (!id) return <p>Choose an organization to view its members.</p>;
  return <section className="organization-panel"><h2>Members and invitations</h2>
    {members.isError && <p role="alert">Members could not be loaded.</p>}
    <ul>{members.data?.members.map(member => <li key={member.user_id}>
      {member.email} — {member.role}, {member.state}{member.is_creator ? " (creator)" : ""}
      {admin && member.state === "active" && <>
        <button disabled={busy || (member.role === "admin" && ((member.is_creator && member.email.toLowerCase() !== identityEmail?.trim().toLowerCase()) || (members.data?.members.filter(m => m.state === "active" && m.role === "admin").length ?? 0) <= 1))} type="button" onClick={() => void perform(() => organizationsApi.changeMember(member.user_id, member.role === "admin" ? "member" : "admin"))}>{member.role === "admin" ? "Make member" : "Make admin"}</button>
        <button disabled={busy || (member.role === "admin" && ((member.is_creator && member.email.toLowerCase() !== identityEmail?.trim().toLowerCase()) || (members.data?.members.filter(m => m.state === "active" && m.role === "admin").length ?? 0) <= 1))} type="button" onClick={() => void perform(() => organizationsApi.removeMember(member.user_id))}>Remove</button>
      </>}
    </li>)}</ul>
    {admin && <>
      <h3>Create invitation</h3><form onSubmit={e => { e.preventDefault(); void perform(async () => { const result = await organizationsApi.createInvite({ ...(email ? { email } : {}), role, expires_at: new Date(expires).toISOString(), ...(!email && maxUses ? { max_uses: Number(maxUses) } : {}) }); setMinted(result.invite_url ?? result.join_code ?? "This request already completed. Resend to issue a fresh token."); }); }}>
        <label>Email (leave blank for a reusable code)<input type="email" value={email} onChange={e => setEmail(e.target.value)} /></label>
        <label>Role<select value={role} onChange={e => setRole(e.target.value as "member" | "admin")}><option value="member">Member</option><option value="admin">Admin</option></select></label>
        <label>Expiry<input type="datetime-local" value={expires} onChange={e => setExpires(e.target.value)} required /></label>
        {!email && <label>Maximum uses (blank for unlimited)<input type="number" min={1} value={maxUses} onChange={e => setMaxUses(e.target.value)} /></label>}
        <button disabled={busy}>Create invitation</button>
      </form>
      {minted && <p role="status">Copy this invitation now: <output>{minted}</output><button type="button" onClick={() => setMinted(null)}>Hide</button></p>}
      <h3>Invitation history</h3><ul>{invites.data?.invites.map(invite => <li key={invite.id}>{invite.email ?? "Reusable code"} — {invite.role}, {invite.use_count} uses, expires {invite.expires_at}
        {!invite.revoked_at && <><button disabled={busy} type="button" onClick={() => void perform(async () => { const result = await organizationsApi.resendInvite(invite.id); setMinted(result.invite_url ?? result.join_code ?? "Resend again with a fresh request to rotate the token."); })}>Resend</button>
        <button disabled={busy} type="button" onClick={() => void perform(() => organizationsApi.revokeInvite(invite.id))}>Revoke</button></>}
      </li>)}</ul>
    </>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
