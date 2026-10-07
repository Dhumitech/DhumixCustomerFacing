import { dhumiClient } from "./client";
import { asDhumiRequest, DhumiApiError } from "./errors";
import { organizationHeaders } from "./organizationScope";
import { tokenStore } from "../session/tokenStore";
import {
  listOrganizations, createOrganization, acceptInvite, requestPasswordReset, confirmVerification, resendVerification,
  listMembers as listOrganizationMembers, updateMember as changeOrganizationMember, removeMember as removeOrganizationMember, listInvites as listOrganizationInvites,
  createInvite as createOrganizationInvite, revokeInvite as revokeOrganizationInvite, resendInvite as resendOrganizationInvite,
  type OrganizationInviteInput, type VerificationConfirmInput,
} from "./generated";

type MutationHeaders = Record<string, string> & { "Idempotency-Key": string; "X-CSRF-Token": string };
const mutationHeaders = (): MutationHeaders => ({ ...organizationHeaders(), "Idempotency-Key": `organization.${crypto.randomUUID()}`, "X-CSRF-Token": tokenStore.getSnapshot()?.csrf_token ?? "" });
const base = () => ({ client: dhumiClient, throwOnError: true as const });
// Replay tickets are memory-only. No password, code, link or active selector
// enters local/session storage. Uncertain responses retain the same request key.
const tickets = new Map<string, string>();
const salt = crypto.randomUUID();
async function mutation<T>(action: string, body: unknown, work: (headers: ReturnType<typeof mutationHeaders>) => Promise<{ data: T }>, explicitKey?: string): Promise<T> {
  const headers = mutationHeaders();
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([salt, action, headers["X-Dhumi-Organization"], tokenStore.getIdentitySnapshot(), body])));
  const fingerprint = Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, "0")).join("");
  const key = explicitKey ?? tickets.get(fingerprint) ?? headers["Idempotency-Key"];
  tickets.set(fingerprint, key);
  if (tickets.size > 128) tickets.delete(tickets.keys().next().value!);
  const clear = () => { if (tickets.get(fingerprint) === key) tickets.delete(fingerprint); };
  try { const result = await work({ ...headers, "Idempotency-Key": key }); clear(); return result.data; }
  catch (error) { if (error instanceof DhumiApiError && error.status !== null && error.status < 500 && error.status !== 429) clear(); throw error; }
}
export const organizationsApi = {
  async list() { return (await asDhumiRequest(listOrganizations(base()))).data; },
  async create(name: string) { return mutation("create", { name }, headers => asDhumiRequest(createOrganization({ ...base(), body: { name }, headers }))); },
  async join(code: string, emailInvite = false) { const body = emailInvite ? { invite_token: code } : { join_code: code }; return mutation("join", body, headers => asDhumiRequest(acceptInvite({ ...base(), body, headers }))); },
  async reset(email: string) { return mutation("reset", { email }, headers => asDhumiRequest(requestPasswordReset({ ...base(), body: { email }, headers }))); },
  async confirm(id: string, body: VerificationConfirmInput, key?: string) {
    return mutation("confirm", { id, body }, headers => asDhumiRequest(confirmVerification({ ...base(), body, path: { verification_id: id }, headers })), key);
  },
  async resend(id: string) { return mutation("resend", { id }, headers => asDhumiRequest(resendVerification({ ...base(), body: {}, path: { verification_id: id }, headers }))); },
  async members() { return (await asDhumiRequest(listOrganizationMembers({ ...base(), headers: organizationHeaders() }))).data; },
  async changeMember(user_id: string, role: "admin" | "member") { return mutation("memberRole", { user_id, role }, headers => asDhumiRequest(changeOrganizationMember({ ...base(), path: { user_id }, body: { role }, headers }))); },
  async removeMember(user_id: string) { await mutation("removeMember", { user_id }, headers => asDhumiRequest(removeOrganizationMember({ ...base(), path: { user_id }, headers }))); },
  async invites() { return (await asDhumiRequest(listOrganizationInvites({ ...base(), headers: organizationHeaders() }))).data; },
  async createInvite(body: OrganizationInviteInput) { return mutation("createInvite", body, headers => asDhumiRequest(createOrganizationInvite({ ...base(), body, headers }))); },
  async revokeInvite(invite_id: string) { await mutation("revokeInvite", { invite_id }, headers => asDhumiRequest(revokeOrganizationInvite({ ...base(), path: { invite_id }, headers }))); },
  async resendInvite(invite_id: string) { return mutation("resendInvite", { invite_id }, headers => asDhumiRequest(resendOrganizationInvite({ ...base(), path: { invite_id }, body: {}, headers }))); },
};
