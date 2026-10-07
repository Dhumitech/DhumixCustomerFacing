import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { organizationsApi } from "../../api/organizations";
import { tokenStore } from "../../session/tokenStore";

export function PasswordResetPanel({ onDone }: { onDone: () => void }) {
  const queries = useQueryClient();
  const [email, setEmail] = useState(""); const [id, setId] = useState<string | null>(null);
  const [code, setCode] = useState(""); const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState<string | null>(null);
  async function work(run: () => Promise<void>) { setBusy(true); setMessage(null); try { await run(); } catch { setMessage("The request could not be completed. Use a fresh code and try again."); } finally { setBusy(false); } }
  return <section><h3>Reset password</h3>
    <form onSubmit={e => { e.preventDefault(); void work(async () => {
      if (!id) { const result = await organizationsApi.reset(email); setId(result.verification_id); setMessage("If this address can reset its password, a code has been sent."); }
      else { await organizationsApi.confirm(id, { code, new_password: password }); tokenStore.clear(); queries.clear(); setPassword(""); setCode(""); onDone(); }
    }); }}>
      {!id ? <label>Email<input type="email" value={email} onChange={e => setEmail(e.target.value)} required maxLength={320} /></label> : <>
        <label>Verification code<input value={code} onChange={e => setCode(e.target.value)} required pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" inputMode="numeric" /></label>
        <label>New password<input type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={12} maxLength={256} autoComplete="new-password" /></label>
      </>}
      <button disabled={busy}>{id ? "Reset password and sign in again" : "Send reset code"}</button>
    </form>
    {id && <button disabled={busy} type="button" onClick={() => void work(async () => { const result = await organizationsApi.resend(id); setId(result.verification_id); setCode(""); setMessage("If a fresh code can be issued, it has been sent. Wait at least 60 seconds between requests."); })}>Resend code</button>}
    {message && <p role="status">{message}</p>}
    <button type="button" onClick={onDone}>Back to sign in</button>
  </section>;
}
