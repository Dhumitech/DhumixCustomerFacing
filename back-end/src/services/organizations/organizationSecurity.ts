import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { ApplicationError } from "../../utils/applicationError.js";

export type VerificationPurpose = "create_organization" | "join_organization" | "password_reset";
export type OrganizationRole = "admin" | "member";
export const digest = (value: string): Buffer => createHash("sha256").update(value).digest();
export const secretToken = (): string => randomBytes(32).toString("base64url");
export const verificationCode = (): string => randomInt(0, 1_000_000).toString().padStart(6, "0");
export function codeHash(secret: string, id: string, user: string, purpose: VerificationPurpose, code: string): Buffer {
  return createHmac("sha256", secret).update(JSON.stringify(["dhumi-verification:v1", id, user, purpose, code])).digest();
}
export function equalDigest(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
export function workflowConflict(title = "Verification unavailable"): ApplicationError {
  return new ApplicationError({ status: 409, code: "STATE_CONFLICT", title });
}
/** Caller and target come from locked, active membership rows. */
export function assertMemberChange(input: {
  callerId: string; creatorId: string; targetId: string; targetRole: OrganizationRole;
  activeAdmins: number; nextRole: OrganizationRole; remove: boolean;
}): void {
  const losesAdmin = input.targetRole === "admin" && (input.remove || input.nextRole === "member");
  if (losesAdmin && input.creatorId === input.targetId && input.callerId !== input.targetId)
    throw new ApplicationError({ status: 403, code: "ACCESS_DENIED", title: "The active creator administrator is protected" });
  if (losesAdmin && input.activeAdmins <= 1)
    throw workflowConflict("An active organization must retain an administrator");
}
