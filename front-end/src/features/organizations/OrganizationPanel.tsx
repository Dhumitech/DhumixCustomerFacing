import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router";
import { organizationsApi } from "../../api/organizations";
import { ORGANIZATION_NEEDED, organizationPath, selectedOrganization } from "../../api/organizationScope";
import { useSession } from "../../session/useSession";

export function OrganizationPanel() {
  const { identityEmail } = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const queries = useQueryClient();
  const organizationId = selectedOrganization(location.pathname);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resendAt, setResendAt] = useState(0);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
      if (event.key !== "Tab") return;
      const controls = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]');
      const first = controls?.[0], last = controls?.[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); previous?.focus(); };
  }, [open]);
  const memberships = useQuery({ queryKey: ["organizations", identityEmail], queryFn: organizationsApi.list });
  useEffect(() => { const show = () => setOpen(true); window.addEventListener(ORGANIZATION_NEEDED, show); return () => window.removeEventListener(ORGANIZATION_NEEDED, show); }, []);
  async function perform(work: () => Promise<void>) { setError(null); setBusy(true); try { await work(); } catch { setError("The request could not be completed. Check the details and try again."); } finally { setBusy(false); } }
  function select(id: string) {
    const unscoped = location.pathname.replace(/^\/o\/[^/]+/, "");
    navigate(organizationPath(unscoped.startsWith("/workspace") ? unscoped + location.search : "/workspace/scrapers", id));
    setOpen(false); setPending(null);
  }
  return <div>
    <button type="button" onClick={() => setOpen(true)}>Organizations</button>
    {organizationId && <button type="button" onClick={() => navigate("/workspace/scrapers")}>Browse all</button>}
    {open && <section ref={panel} tabIndex={-1} className="organization-panel organization-panel--dialog" role="dialog" aria-modal="true" aria-label="Choose an organization">
      <h2>Choose an organization</h2><button type="button" onClick={() => setOpen(false)}>Close</button>
      <p>Create or join to save a service, start a Run, download a sample or contact an expert. Your action will wait for you to retry.</p>
      {memberships.data?.organizations.map(org => <button key={org.id} type="button" onClick={() => select(org.id)}>{org.name} ({org.role})</button>)}
      {memberships.isError && <p role="alert">Organizations could not be loaded.</p>}
      {!pending ? <>
        <form onSubmit={event => { event.preventDefault(); void perform(async () => { const result = await organizationsApi.create(name); setPending(result.verification_id); setResendAt(Date.now() + 60_000); if (result.message) setError(result.message); }); }}>
          <label>Organization name<input value={name} onChange={e => setName(e.target.value)} required maxLength={120} /></label><button disabled={busy || !name.trim()}>Create organization</button>
        </form>
        <form onSubmit={event => { event.preventDefault(); void perform(async () => { const result = await organizationsApi.join(joinCode); setPending(result.verification_id); setResendAt(Date.now() + 60_000); if (result.message) setError(result.message); }); }}>
          <label>Join code<input value={joinCode} onChange={e => setJoinCode(e.target.value)} required autoComplete="off" /></label><button disabled={busy}>Join organization</button>
        </form>
      </> : <form onSubmit={event => { event.preventDefault(); void perform(async () => { const result = await organizationsApi.confirm(pending, { code }); await queries.invalidateQueries({ queryKey: ["organizations"] }); if (result.organization_id) select(result.organization_id); }); }}>
        <p>Check your email for a fresh verification code. No organization change has happened yet.</p>
        <label>Verification code<input value={code} onChange={e => setCode(e.target.value)} pattern="[0-9]{6}" maxLength={6} inputMode="numeric" autoComplete="one-time-code" required /></label>
        <button disabled={busy}>Confirm</button><button type="button" disabled={busy} onClick={() => { if (Date.now() < resendAt) { setError("Wait 60 seconds before resending."); return; } void perform(async () => { const result = await organizationsApi.resend(pending); setPending(result.verification_id); setCode(""); setResendAt(Date.now() + 60_000); }); }}>Resend code</button>
      </form>}
      {error && <p role="alert">{error}</p>}
    </section>}
  </div>;
}
