import { runtimeConfig } from "../config/runtime";
import { tokenStore } from "../session/tokenStore";
import { dhumiClient } from "./client";
import { asDhumiRequest, DhumiApiError } from "./errors";
import {
  type AuthAccepted,
  type AuthSession,
  logout as generatedLogout,
  refreshSession as generatedRefreshSession,
  signIn as generatedSignIn,
  signUp as generatedSignUp,
  restoreSession as generatedRestoreSession,
} from "./generated";
import {
  acquireMutationIdempotency,
  completeMutationIdempotency,
} from "./mutationIdempotency";

export { DhumiApiError } from "./errors";

export interface SignUpRequest {
  /** Historical callers may still supply it; ignored by user-only signup. */
  readonly companyNameOrWebsite?: string;
  readonly email: string;
  readonly password: string;
}

export interface SignInRequest {
  readonly email: string;
  readonly password: string;
}
let restorePending: Promise<AuthSession | null> | null = null;

export const authApi = Object.freeze({
  async restore(): Promise<AuthSession | null> {
    const current = tokenStore.getSnapshot();
    if (current) return current;
    if (restorePending) return restorePending;
    const revision = tokenStore.getRevision();
    restorePending = (async () => {
      try {
        const { data } = await asDhumiRequest(
          generatedRestoreSession({ client: dhumiClient, throwOnError: true }),
        );
        const session: AuthSession = {
          access_token: data.access_token,
          token_type: data.token_type,
          expires_in: data.expires_in,
          csrf_token: data.csrf_token,
        };
        if (
          tokenStore.getRevision() === revision &&
          tokenStore.getSnapshot() === null
        )
          tokenStore.set(session, data.identity_email);
        return session;
      } catch (error) {
        if (
          error instanceof DhumiApiError &&
          (error.status === 401 || error.status === 403)
        )
          return null;
        throw error;
      } finally {
        restorePending = null;
      }
    })();
    return restorePending;
  },
  async signUp(input: SignUpRequest): Promise<AuthAccepted> {
    if (runtimeConfig.signupLegalAcceptances.length === 0) {
      throw new Error(
        "Signup is not configured with approved legal-document metadata.",
      );
    }

    const body = {
      email: input.email,
      password: input.password,
      legal_acceptances: [...runtimeConfig.signupLegalAcceptances],
    };
    const lease = await acquireMutationIdempotency("auth.signup", body);
    const response = await asDhumiRequest(
      generatedSignUp({
        client: dhumiClient,
        body,
        headers: { "Idempotency-Key": lease.headerValue },
        throwOnError: true,
      }),
    );
    completeMutationIdempotency(lease);
    return response.data;
  },

  async signIn(input: SignInRequest): Promise<AuthSession> {
    const response = await asDhumiRequest(
      generatedSignIn({
        client: dhumiClient,
        body: input,
        throwOnError: true,
      }),
    );
    const session = response.data;
    tokenStore.set(session, input.email);
    return session;
  },

  async refresh(): Promise<AuthSession> {
    const current = tokenStore.getSnapshot();
    if (current === null) {
      throw new Error("No in-memory browser session is available to refresh.");
    }

    const response = await asDhumiRequest(
      generatedRefreshSession({
        client: dhumiClient,
        headers: { "X-CSRF-Token": current.csrf_token },
        throwOnError: true,
      }),
    );
    const session = response.data;
    // A logout or another refresh may have replaced this session while the
    // request was in flight. Never let a stale response restore/overwrite it.
    if (tokenStore.getSnapshot() === current) {
      tokenStore.set(session);
    }
    return session;
  },

  async logout(): Promise<void> {
    const current = tokenStore.getSnapshot();
    if (current === null) {
      return;
    }

    await asDhumiRequest(
      generatedLogout({
        client: dhumiClient,
        headers: { "X-CSRF-Token": current.csrf_token },
        throwOnError: true,
      }),
    );
    tokenStore.clear();
  },
});
