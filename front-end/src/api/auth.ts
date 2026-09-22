import { runtimeConfig } from "../config/runtime";
import { tokenStore } from "../session/tokenStore";
import { dhumiClient } from "./client";
import { asDhumiRequest } from "./errors";
import {
  type AuthAccepted,
  type AuthSession,
  logout as generatedLogout,
  refreshSession as generatedRefreshSession,
  signIn as generatedSignIn,
  signUp as generatedSignUp,
} from "./generated";
import {
  acquireMutationIdempotency,
  completeMutationIdempotency,
} from "./mutationIdempotency";

export { DhumiApiError } from "./errors";

export interface SignUpRequest {
  readonly companyNameOrWebsite: string;
  readonly email: string;
  readonly password: string;
}

export interface SignInRequest {
  readonly email: string;
  readonly password: string;
}

export const authApi = Object.freeze({
  async signUp(input: SignUpRequest): Promise<AuthAccepted> {
    if (runtimeConfig.signupLegalAcceptances.length === 0) {
      throw new Error(
        "Signup is not configured with approved legal-document metadata.",
      );
    }

    const body = {
      workspace_name: input.companyNameOrWebsite,
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
