import { createHash, createHmac, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, lstat, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OrganizationEmailConfig } from "../../config/organizationEnvironment.js";
import type { VerificationPurpose } from "./organizationSecurity.js";

export interface WorkflowMail { recipient: string; subject: string; text: string; traceId: string; purpose?: VerificationPurpose | "organization_invite" }
export type MailOutcome = "accepted" | "configuration_error" | "rate_limited" | "uncertain";
export interface MailReceipt { outcome: MailOutcome; operationId: string; operationLocation?: string; retryAfterSeconds?: number }
export interface WorkflowEmailSender { send(mail: WorkflowMail): Promise<MailOutcome | MailReceipt>; close(): void }
export function verificationMail(input: {
  recipient: string; id: string; code: string; token?: string; purpose: VerificationPurpose; publicUrl: string; traceId: string;
}): WorkflowMail {
  const action = input.purpose === "password_reset" ? "reset your password" : input.purpose === "create_organization" ? "create an organization" : "join an organization";
  const link = input.token ? `\nOr open ${input.publicUrl}/verify#verification_id=${input.id}&email_link_token=${input.token}\nConfirm explicitly after signing in to the same account.` : "";
  return { recipient: input.recipient, traceId: input.traceId, purpose: input.purpose, subject: "Dhumi verification", text: `Your code to ${action} is ${input.code}.\nIt expires in 10 minutes.${link}\nIf you did not request this, ignore this email.` };
}
// REST 2025-09-01: sign the exact bytes sent, using only Node primitives.
export function acsHeaders(url: URL, body: string, key: string, date: string, operation: string, trace: string): Record<string, string> {
  const bodyHash = createHash("sha256").update(body).digest("base64");
  const signed = `POST\n${url.pathname}${url.search}\n${date};${url.host};${bodyHash}`;
  const signature = createHmac("sha256", Buffer.from(key, "base64")).update(signed).digest("base64");
  return { "Content-Type": "application/json", "x-ms-date": date, "x-ms-content-sha256": bodyHash,
    Authorization: `HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${signature}`,
    "Operation-Id": operation, "x-ms-client-request-id": trace };
}
export function createAcsEmailSender(config: OrganizationEmailConfig, fetcher: typeof fetch = fetch): WorkflowEmailSender {
  if (!config.acsEndpoint || !config.acsAccessKey) throw new Error("ACS configuration is required");
  const url = new URL("/emails:send?api-version=2025-09-01", config.acsEndpoint);
  const key = config.acsAccessKey;
  return { close() {}, async send(mail) {
    const operation = randomUUID();
    const receipt = (outcome: MailOutcome): MailReceipt => ({ outcome, operationId: operation });
    const body = JSON.stringify({ senderAddress: config.sender, recipients: { to: [{ address: mail.recipient }] },
      content: { subject: mail.subject, plainText: mail.text }, userEngagementTrackingDisabled: true });
    try {
      const response = await fetcher(url, { method: "POST", redirect: "error", body,
        headers: acsHeaders(url, body, key, new Date().toUTCString(), operation, mail.traceId), signal: AbortSignal.timeout(5_000) });
      // No response body, recipient or token is logged; no automatic send retry.
      if (response.status === 401 || response.status === 403) { await response.body?.cancel(); return receipt("configuration_error"); }
      if (response.status === 429) {
        const delay = Number(response.headers.get("Retry-After"));
        await response.body?.cancel();
        return { ...receipt("rate_limited"), ...(Number.isSafeInteger(delay) && delay > 0 ? { retryAfterSeconds: delay } : {}) };
      }
      const location = response.headers.get("Operation-Location");
      if (response.status !== 202 || !location || !response.body) { await response.body?.cancel(); return receipt("uncertain"); }
      const operationUrl = new URL(location, url);
      if (operationUrl.origin !== url.origin || operationUrl.pathname !== `/emails/operations/${operation}`) { await response.body.cancel(); return receipt("uncertain"); }
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
          if (size > 8192) { await reader.cancel(); return receipt("uncertain"); } chunks.push(part.value); }
      } finally { reader.releaseLock(); }
      const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (typeof result !== "object" || result === null || !("id" in result) || result.id !== operation) return receipt("uncertain");
      return { ...receipt("accepted"), operationLocation: operationUrl.toString() };
    } catch { return receipt("uncertain"); }
  } };
}
/** Local plaintext is deliberately confined to ignored, owner-only .eml files. */
export async function createFileEmailSender(config: OrganizationEmailConfig, directory: string): Promise<WorkflowEmailSender> {
  if (config.driver !== "file") throw new Error("File driver configuration required");
  const root = path.resolve(directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  if ((await lstat(root)).isSymbolicLink()) throw new Error("Mail directory cannot be a symbolic link");
  if (process.platform !== "win32") await chmod(root, 0o700);
  if (process.platform === "win32") {
    const execute = promisify(execFile);
    const identity = await execute("whoami.exe", ["/user", "/fo", "csv", "/nh"]);
    const sid = /S-1-\d+(?:-\d+)+/.exec(identity.stdout)?.[0];
    if (!sid) throw new Error("Cannot resolve the local mail owner");
    await execute("icacls.exe", [root, "/reset"], { windowsHide: true });
    await execute("icacls.exe", [root, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`], { windowsHide: true });
  }
  async function clean(): Promise<void> {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[0-9a-f-]{36}\.eml$/.test(entry.name)) continue;
      const file = path.join(root, entry.name);
      const stat = await lstat(file);
      if (!stat.isSymbolicLink() && Date.now() - stat.mtimeMs > 86_400_000) await unlink(file);
    }
  }
  await clean();
  const timer = setInterval(() => { void clean().catch(() => undefined); }, 3_600_000);
  timer.unref();
  return { close() { clearInterval(timer); }, async send(mail) {
    if (/[\r\n]/.test(mail.recipient + config.sender + mail.subject)) return "configuration_error";
    try {
      await writeFile(path.join(root, `${randomUUID()}.eml`), `From: ${config.sender}\r\nTo: ${mail.recipient}\r\nSubject: ${mail.subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${mail.text}`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      return "accepted";
    } catch { return "uncertain"; }
  } };
}
