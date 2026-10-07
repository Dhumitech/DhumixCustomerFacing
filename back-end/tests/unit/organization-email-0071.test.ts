import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import { loadOrganizationEmailConfig, loadOrganizationInviteResendLifetimeDays } from "../../src/config/organizationEnvironment.js";
import { acsHeaders, createAcsEmailSender, createFileEmailSender, verificationMail } from "../../src/services/organizations/verificationEmail.js";

const env = { APP_ENVIRONMENT: "local", NODE_ENV: "test", OTP_SECRET: "unit-only-otp-secret-32-bytes-minimum", APP_PUBLIC_URL: "http://localhost:5173", EMAIL_FROM: "sender@example.test", EMAIL_DRIVER: "file" };
const acs = () => loadOrganizationEmailConfig({ ...env, EMAIL_DRIVER: "acs", ACS_EMAIL_ENDPOINT: "https://unit.communication.azure.com", ACS_EMAIL_ACCESS_KEY: Buffer.alloc(32, 1).toString("base64") });
const mail = () => verificationMail({ recipient: "user@example.test", id: randomUUID(), code: "123456", token: "high-entropy-unit-token", purpose: "join_organization", publicUrl: "https://dhumi.example", traceId: randomUUID() });
describe("organization invitation resend configuration", () => {
  it("defaults to seven days and accepts an editable whole-day value", () => {
    expect(loadOrganizationInviteResendLifetimeDays({})).toBe(7);
    expect(loadOrganizationInviteResendLifetimeDays({ ORGANIZATION_INVITE_RESEND_LIFETIME_DAYS: "3" })).toBe(3);
  });
  it.each(["", "0", "-1", "1.5", "seven", "2147483648"])("rejects invalid lifetime %j before startup", value => {
    expect(() => loadOrganizationInviteResendLifetimeDays({ ORGANIZATION_INVITE_RESEND_LIFETIME_DAYS: value })).toThrow("ORGANIZATION_INVITE_RESEND_LIFETIME_DAYS");
  });
});
describe("0071 email boundary", () => {
  it.each(["shared_dev", "production"])("rejects file delivery in %s", APP_ENVIRONMENT => {
    expect(() => loadOrganizationEmailConfig({ ...env, APP_ENVIRONMENT, APP_PUBLIC_URL: "https://localhost" })).toThrow("restricted");
  });
  it("rejects production file delivery even when the local label is supplied", () => expect(() => loadOrganizationEmailConfig({ ...env, NODE_ENV: "production" })).toThrow("restricted"));
  it.each(["http://mail.communication.azure.com", "https://example.test", "https://unit.communication.azure.com/private", "https://user:password@unit.communication.azure.com"])("refuses unsafe ACS origin %s", ACS_EMAIL_ENDPOINT => {
    expect(() => loadOrganizationEmailConfig({ ...env, EMAIL_DRIVER: "acs", ACS_EMAIL_ENDPOINT, ACS_EMAIL_ACCESS_KEY: Buffer.alloc(32).toString("base64") })).toThrow();
  });
  it("requires an independently supplied OTP secret", () => expect(() => loadOrganizationEmailConfig({ ...env, OTP_SECRET: "" })).toThrow("OTP_SECRET"));
  it("matches a pinned HMAC signature for exact POST bytes", () => {
    const headers = acsHeaders(new URL("https://unit.communication.azure.com/emails:send?api-version=2025-09-01"), '{"test":true}', Buffer.alloc(32, 1).toString("base64"), "Wed, 07 Oct 2026 00:00:00 GMT", "operation", "trace");
    expect(headers["x-ms-content-sha256"]).toBe("b9l325sq/oepzu5IQyiBKZpqr4PZNfu+gwB2YCh/nC4=");
    expect(headers.Authorization).toBe("HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=YHV7zyLZxwoMUuUSzE/fChhD0/GFzDb5f2QJgvRlbCg=");
  });
  it("uses one recipient/plain text/no tracking and checks returned operation correspondence", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("https://unit.communication.azure.com/emails:send?api-version=2025-09-01");
      expect(init?.redirect).toBe("error"); expect(init?.signal).toBeInstanceOf(AbortSignal);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.recipients).toEqual({ to: [{ address: "user@example.test" }] });
      expect(body.userEngagementTrackingDisabled).toBe(true); expect(body.content).not.toHaveProperty("html");
      const id = new Headers(init?.headers).get("Operation-Id")!;
      return new Response(JSON.stringify({ id, status: "Running" }), { status: 202, headers: { "Operation-Location": `https://unit.communication.azure.com/emails/operations/${id}?api-version=2025-09-01` } });
    });
    const result = await createAcsEmailSender(acs(), fetcher).send(mail());
    expect(result).toMatchObject({ outcome: "accepted" }); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([401,403,429,500])("classifies HTTP %i with no retry", async status => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status, headers: { "Retry-After": "60" } }));
    const result = await createAcsEmailSender(acs(), fetcher).send(mail());
    expect(result).toMatchObject({ outcome: status === 429 ? "rate_limited" : status === 500 ? "uncertain" : "configuration_error" });
    if (status === 429) expect(result).toMatchObject({ retryAfterSeconds: 60 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("records uncertain transport once without automatic retry", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => { throw new Error("unit transport unavailable"); });
    expect(await createAcsEmailSender(acs(), fetcher).send(mail())).toMatchObject({ outcome: "uncertain" }); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not accept a mismatched operation ID", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => new Response(JSON.stringify({ id: randomUUID() }), { status: 202, headers: { "Operation-Location": `https://unit.communication.azure.com/emails/operations/${new Headers(init?.headers).get("Operation-Id")}` } }));
    expect(await createAcsEmailSender(acs(), fetcher).send(mail())).toMatchObject({ outcome: "uncertain" });
  });
  it("writes local .eml and removes only stale managed files", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dhumi-mail-unit-"));
    let sender: Awaited<ReturnType<typeof createFileEmailSender>> | undefined;
    try {
      const old = path.join(directory, `${randomUUID()}.eml`);
      await writeFile(old, "expired-unit-mail"); await utimes(old, new Date(0), new Date(0));
      await writeFile(path.join(directory, "keep.txt"), "unrelated");
      sender = await createFileEmailSender(loadOrganizationEmailConfig(env), directory);
      expect(await sender.send(mail())).toBe("accepted");
      const files = await readdir(directory); expect(files).toContain("keep.txt"); expect(files).not.toContain(path.basename(old));
      const eml = files.find(name => name.endsWith(".eml"))!;
      expect(await readFile(path.join(directory, eml), "utf8")).toContain("123456");
      if (process.platform !== "win32") expect((await stat(path.join(directory, eml))).mode & 0o777).toBe(0o600);
    } finally {
      sender?.close();
      if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith("dhumi-mail-unit-")) throw new Error("Unsafe unit cleanup target");
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("keeps reset OTP-only and join links in URL fragments", () => {
    const message = mail(); expect(message.text).toContain("/verify#verification_id=");
    const reset = verificationMail({ recipient: "user@example.test", id: randomUUID(), code: "123456", purpose: "password_reset", publicUrl: "https://dhumi.example", traceId: randomUUID() });
    expect(reset.text).not.toContain("/verify");
  });
});
