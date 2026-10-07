import { useEffect, useRef, useState } from "react";
import { organizationsApi } from "../../api/organizations";
import { DhumiApiError } from "../../api/errors";
import { organizationPath } from "../../api/organizationScope";
import { useSession } from "../../session/useSession";
import { WelcomePage } from "../authentication/WelcomePage";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";

/** Capture once, clear before rendering links, and never consume a proof on GET/mount. */
export function readVerificationFragment(): { id: string; token: string; invite: string } {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const value = { id: params.get("verification_id") ?? "", token: params.get("email_link_token") ?? "", invite: params.get("invite_token") ?? "" };
  if (window.location.hash) window.history.replaceState(null, "", window.location.pathname);
  return value;
}
export function VerificationPage() {
  const navigate = useNavigate();
  const queries = useQueryClient();
  const fragment = useRef<ReturnType<typeof readVerificationFragment> | null>(null);
  if (!fragment.current) fragment.current = readVerificationFragment();
  const { isAuthenticated } = useSession();
  const [id, setId] = useState(fragment.current.id);
  const [code, setCode] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const replayKey = useRef(`verification.${crypto.randomUUID()}`);
  useEffect(() => {
    const old = document.querySelector<HTMLMetaElement>('meta[name="referrer"]');
    const meta = old ?? document.createElement("meta"); const previous = meta.content;
    meta.name = "referrer"; meta.content = "no-referrer"; if (!old) document.head.append(meta);
    return () => { if (!old) meta.remove(); else meta.content = previous; };
  }, []);
  if (!isAuthenticated) return <><p>Sign in to the account that requested this verification or received this invitation. Then explicitly confirm below.</p><WelcomePage initialAuthMode="sign-in" /></>;
  async function confirm() {
    setBusy(true); setMessage(null);
    try {
      if (!id && fragment.current?.invite) { const result = await organizationsApi.join(fragment.current.invite, true); setId(result.verification_id); setMessage("Check your email for a fresh code, then confirm."); }
      else {
        const result = await organizationsApi.confirm(id, fragment.current?.token ? { email_link_token: fragment.current.token } : { code }, replayKey.current);
        if (result.organization_id) { await queries.invalidateQueries({ queryKey: ["organizations"] }); navigate(organizationPath("/workspace/scrapers", result.organization_id), { replace: true }); }
      }
    } catch (error) { setMessage("Verification could not be completed. Use the same account and a fresh code or link.");
      if (error instanceof DhumiApiError && error.status !== null && error.status < 500 && error.status !== 429) replayKey.current = `verification.${crypto.randomUUID()}`; }
    finally { setBusy(false); }
  }
  return <main className="organization-panel"><h1>{fragment.current.invite ? "Join organization" : "Confirm email verification"}</h1>
    <p>This page makes no change until you press Confirm.</p>
    {id && !fragment.current.token && <label>Verification code<input value={code} onChange={e => setCode(e.target.value)} maxLength={6} inputMode="numeric" autoComplete="one-time-code" /></label>}
    <button disabled={busy || (!fragment.current.invite && !id)} type="button" onClick={() => void confirm()}>Confirm</button>
    {message && <p role="status">{message}</p>}
  </main>;
}
