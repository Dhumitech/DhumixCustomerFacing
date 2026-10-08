import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";

export const databaseTlsEnvironmentShape = {
  DATABASE_SSL_MODE: z.enum(["disable", "verify-full"]).default("disable"),
  DATABASE_SSL_CA_FILE: z.string().trim().optional(),
  // A single-line public CA bundle makes the private deployment env portable.
  DATABASE_SSL_CA_BASE64: z.string().trim().max(100_000).optional(),
};

interface DatabaseTlsEnvironment {
  readonly DATABASE_SSL_MODE: "disable" | "verify-full";
  readonly DATABASE_SSL_CA_FILE?: string | undefined;
  readonly DATABASE_SSL_CA_BASE64?: string | undefined;
}

export function addDatabaseTlsChecks(value: DatabaseTlsEnvironment, context: z.RefinementCtx): void {
  if (value.DATABASE_SSL_CA_FILE && value.DATABASE_SSL_CA_BASE64) {
    context.addIssue({ code: "custom", path: ["DATABASE_SSL_CA_BASE64"],
      message: "set exactly one CA source: DATABASE_SSL_CA_FILE or DATABASE_SSL_CA_BASE64" });
  }
  if (value.DATABASE_SSL_MODE === "verify-full" && !value.DATABASE_SSL_CA_FILE && !value.DATABASE_SSL_CA_BASE64) {
    context.addIssue({ code: "custom", path: ["DATABASE_SSL_CA_FILE"],
      message: "DATABASE_SSL_CA_FILE or DATABASE_SSL_CA_BASE64 is required for verify-full" });
  }
  if (value.DATABASE_SSL_MODE === "disable" && value.DATABASE_SSL_CA_BASE64) {
    context.addIssue({ code: "custom", path: ["DATABASE_SSL_MODE"],
      message: "inline certificate configuration requires verify-full" });
  }
}

export function databaseTlsConfiguration(
  value: DatabaseTlsEnvironment,
  ConfigurationError: new (message: string) => Error,
): false | { readonly ca: string; readonly rejectUnauthorized: true } {
  if (value.DATABASE_SSL_MODE === "disable") return false;
  let ca: string;
  if (value.DATABASE_SSL_CA_BASE64) {
    const encoded = value.DATABASE_SSL_CA_BASE64;
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded) {
      throw new ConfigurationError("DATABASE_SSL_CA_BASE64 must be canonical base64");
    }
    ca = bytes.toString("utf8");
  } else {
    const path = value.DATABASE_SSL_CA_FILE;
    if (!path || !isAbsolute(path)) {
      throw new ConfigurationError("DATABASE_SSL_CA_FILE must be an absolute path");
    }
    try { ca = readFileSync(path, "utf8"); }
    catch { throw new ConfigurationError("DATABASE_SSL_CA_FILE could not be read"); }
  }
  // Trust bundles contain public CA certificates only, never client/private keys.
  const certificates = ca.match(/-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----/g);
  try {
    if (!certificates?.length || ca.replace(/-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----/g, "").trim()) {
      throw new Error("Invalid public certificate bundle");
    }
    if (certificates.some(certificate => !new X509Certificate(certificate).ca)) {
      throw new Error("Certificate is not a CA");
    }
  } catch {
    throw new ConfigurationError("Database CA source must contain valid public CA certificates only");
  }
  return { ca, rejectUnauthorized: true };
}
