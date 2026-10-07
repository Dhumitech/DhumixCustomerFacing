import type { CsrfService } from "../../helpers/csrf.js";
import type { PasswordHasher } from "../../helpers/password.js";
import { ApplicationError } from "../../utils/applicationError.js";
import type { TrustedSessionIdentity } from "../identity/browserAuthenticationService.js";
import type { OrganizationAction, OrganizationWorkflowRepository, WorkflowRequest } from "./organizationWorkflowRepository.js";
import type { WorkflowEmailSender, MailOutcome, MailReceipt, WorkflowMail } from "./verificationEmail.js";
import type { WorkflowResponse } from "./workflowIdempotency.js";

export interface OrganizationWorkflowService {
  run(action: OrganizationAction, input: WorkflowRequest, session: TrustedSessionIdentity | null, csrfToken?: string): Promise<WorkflowResponse>;
}
export function createOrganizationWorkflowService(input: {
  repository: OrganizationWorkflowRepository; passwordHasher: PasswordHasher; csrf: CsrfService; email: WorkflowEmailSender;
  recordDelivery: (traceId: string, outcome: MailOutcome, receipt?: MailReceipt, purpose?: WorkflowMail["purpose"]) => void;
}): OrganizationWorkflowService {
  return { async run(action, request, session, csrfToken) {
    const publicAction = ["passwordReset", "confirmVerification", "resendVerification"].includes(action);
    const read = ["listOrganizations", "listMembers", "listInvites"].includes(action);
    if (!publicAction && !session)
      throw new ApplicationError({ status: 401, code: "AUTHENTICATION_REQUIRED", title: "Authentication required" });
    if (session && !read && (!csrfToken || !input.csrf.verify(session.sessionId, csrfToken)))
      throw new ApplicationError({ status: 403, code: "ACCESS_DENIED", title: "CSRF verification failed" });
    if (!read && !/^[A-Za-z0-9._:-]{16,128}$/.test(request.key))
      throw new ApplicationError({ status: 422, code: "VALIDATION_ERROR", title: "A valid Idempotency-Key is required" });
    // Caller identity is always taken from authentication, never the request body.
    const { userId: _discard, ...bound } = request;
    const password = request.body.new_password;
    const result = await input.repository.run(action, { ...bound, ...(session ? { userId: session.userId } : {}),
      ...(action === "confirmVerification" && typeof password === "string" ? { passwordHash: await input.passwordHasher.hash(password) } : {}) });
    // Returning a failure outcome lets attempt increments commit before the HTTP error.
    if (result.failure) throw result.failure;
    if (result.mail) {
      let delivered: MailOutcome | MailReceipt;
      try { delivered = await input.email.send(result.mail); } catch { delivered = "uncertain"; }
      const outcome = typeof delivered === "string" ? delivered : delivered.outcome;
      input.recordDelivery(request.traceId, outcome, typeof delivered === "string" ? undefined : delivered, result.mail.purpose);
      // Public reset stays indistinguishable for known and unknown accounts.
      if (outcome !== "accepted" && result.mail.purpose !== "password_reset")
        return { ...result.response, message: "Try again shortly using Resend." };
    }
    return result.response;
  } };
}
