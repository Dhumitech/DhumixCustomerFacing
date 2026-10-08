/** Resend uses one backend lifetime; creating an invite keeps its explicit expiry. */
export function loadOrganizationCollaborationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.ORGANIZATION_COLLABORATION_ENABLED ?? "false";
  if (flag !== "true" && flag !== "false") throw new Error("ORGANIZATION_COLLABORATION_ENABLED must be true or false");
  return flag === "true";
}

export function loadOrganizationInviteResendLifetimeDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.ORGANIZATION_INVITE_RESEND_LIFETIME_DAYS ?? "7").trim();
  const days = Number(raw);
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(days) || days > 2_147_483_647)
    throw new Error("ORGANIZATION_INVITE_RESEND_LIFETIME_DAYS must be a positive PostgreSQL integer");
  return days;
}

export interface OrganizationEmailConfig {
  readonly otpSecret: string;
  readonly publicUrl: string;
  readonly sender: string;
  readonly driver: "file" | "acs";
  readonly acsEndpoint?: string;
  readonly acsAccessKey?: string;
}
export type OrganizationWorkflowConfig =
  | { readonly demoDisableOtp: true; readonly publicUrl: string }
  | { readonly demoDisableOtp: false; readonly publicUrl: string; readonly email: OrganizationEmailConfig };

export function loadOrganizationWorkflowConfig(env: NodeJS.ProcessEnv = process.env): OrganizationWorkflowConfig {
  const flag = env.DEMO_DISABLE_OTP ?? "false";
  if (flag !== "true" && flag !== "false") throw new Error("DEMO_DISABLE_OTP must be true or false");
  if (flag === "false") {
    const email = loadOrganizationEmailConfig(env);
    return { demoDisableOtp: false, publicUrl: email.publicUrl, email };
  }
  if (env.NODE_ENV === "production" || env.APP_ENVIRONMENT === "production")
    throw new Error("DEMO_DISABLE_OTP is restricted to non-production demos");
  const url = new URL(env.APP_PUBLIC_URL ?? env.FRONTEND_ORIGIN ?? "http://localhost:5173");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      (url.protocol !== "https:" && !(local && url.protocol === "http:")))
    throw new Error("The demo public URL must be a trusted frontend origin");
  return { demoDisableOtp: true, publicUrl: url.origin };
}

export function loadOrganizationEmailConfig(env: NodeJS.ProcessEnv = process.env): OrganizationEmailConfig {
  const otpSecret = env.OTP_SECRET ?? "";
  if (Buffer.byteLength(otpSecret) < 32) throw new Error("OTP_SECRET must contain at least 32 bytes");
  const environment = env.APP_ENVIRONMENT;
  if (!environment || !["local", "shared_dev", "production"].includes(environment))
    throw new Error("APP_ENVIRONMENT must be local, shared_dev or production");
  const url = new URL(env.APP_PUBLIC_URL ?? "");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      (url.protocol !== "https:" && !(environment === "local" && local && url.protocol === "http:")))
    throw new Error("APP_PUBLIC_URL must be a trusted frontend origin");
  const sender = env.EMAIL_FROM ?? "";
  if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(sender)) throw new Error("EMAIL_FROM must be an email address");
  const driver = env.EMAIL_DRIVER;
  if (driver === "file") {
    if (environment !== "local" || env.NODE_ENV === "production" || !local)
      throw new Error("The file email driver is restricted to local development");
    return { otpSecret, publicUrl: url.origin, sender, driver };
  }
  if (driver !== "acs") throw new Error("EMAIL_DRIVER must be file or acs");
  const endpoint = new URL(env.ACS_EMAIL_ENDPOINT ?? "");
  if (endpoint.protocol !== "https:" || !/^[a-z0-9-]+\.communication\.azure\.com$/.test(endpoint.hostname) ||
      endpoint.port || endpoint.username || endpoint.password || endpoint.pathname !== "/" || endpoint.search || endpoint.hash)
    throw new Error("ACS_EMAIL_ENDPOINT must be an Azure Communication Services resource origin");
  const key = env.ACS_EMAIL_ACCESS_KEY ?? "";
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(key) || Buffer.from(key, "base64").length < 32 || Buffer.from(key, "base64").toString("base64") !== key)
    throw new Error("ACS_EMAIL_ACCESS_KEY must be a base64 access key");
  return { otpSecret, publicUrl: url.origin, sender, driver, acsEndpoint: endpoint.origin, acsAccessKey: key };
}
