import type { LockoutConfig, SessionConfig } from "../../config/environment.js";
import type { AccessTokenService } from "../../helpers/accessToken.js";
import type { CsrfService } from "../../helpers/csrf.js";
import type { PasswordHasher } from "../../helpers/password.js";
import type { RefreshTokenService } from "../../helpers/refreshToken.js";
import { normalizeEmail } from "../../helpers/signupCanonicalization.js";
import { ApplicationError } from "../../utils/applicationError.js";
import type { SignInRepository } from "./signInRepository.js";

export interface SignInRequest {
  readonly email: string;
  readonly password: string;
  /** Already validated as a UUID or null; `audit_events.request_id` is `uuid`. */
  readonly requestId: string | null;
  readonly ipFingerprint: Buffer | null;
}

export interface SignInResult {
  readonly accessToken: string;
  readonly expiresInSeconds: number;
  readonly csrfToken: string;
  readonly refreshToken: string;
  readonly refreshExpiresAt: Date;
}

export interface SignInService {
  authenticate(request: SignInRequest): Promise<SignInResult>;
}

export interface SignInServiceDependencies {
  readonly repository: SignInRepository;
  readonly passwordHasher: PasswordHasher;
  readonly accessTokens: AccessTokenService;
  readonly refreshTokens: RefreshTokenService;
  readonly csrf: CsrfService;
  readonly session: SessionConfig;
  readonly lockout: LockoutConfig;
}

/**
 * The single public authentication failure.
 *
 * Unknown email, wrong password and a locked, suspended or closed account all
 * produce this. A distinguishable response for any of them tells an attacker
 * which addresses are real and worth attacking.
 */
export function authenticationFailed(): ApplicationError {
  return new ApplicationError({
    status: 401,
    code: "AUTHENTICATION_REQUIRED",
    title: "Authentication failed",
    detail: "The email address or password is incorrect.",
  });
}

export function createSignInService(
  dependencies: SignInServiceDependencies,
): SignInService {
  const {
    repository,
    passwordHasher,
    accessTokens,
    refreshTokens,
    csrf,
    session,
    lockout,
  } = dependencies;

  /**
   * Verifying against this makes an unknown address cost the same as a real
   * one. Without it the early exit answers in about a millisecond while a real
   * identity takes about 22.5 ms, which is a clean enumeration oracle.
   *
   * Built once at construction, because generating it per request would itself
   * add measurable time to exactly the path being protected.
   */
  const dummyHashPromise = passwordHasher.hash(
    "dhumi-unknown-identity-placeholder-never-a-real-password",
  );
  // Created eagerly but awaited only on the first unknown identity. Without a
  // handler attached now, a rejection here would surface as an unhandled
  // rejection at startup rather than at the call site that cares.
  void dummyHashPromise.catch(() => undefined);

  /**
   * Preliminary account-state filter before the authoritative locked read.
   *
   * `active` may continue. A `locked` account with a recorded failure may also
   * continue far enough for PostgreSQL to calculate expiry under the row lock;
   * the application clock is deliberately not trusted for that decision.
   * `suspended`, `closed`, and malformed locked state never continue.
   */
  function accountMayReachSessionTransaction(
    state: string,
    lastFailedAt: Date | null,
  ): boolean {
    if (state === "active") {
      return true;
    }
    // PostgreSQL performs the authoritative expiry calculation with its own
    // clock while holding the User row lock. This preliminary check only
    // excludes states that can never authenticate.
    return state === "locked" && lastFailedAt !== null;
  }

  return {
    async authenticate(request: SignInRequest): Promise<SignInResult> {
      const emailNormalized = normalizeEmail(request.email);
      const identity = await repository.findIdentity(emailNormalized);

      // Always verify a password, even when no identity matched.
      const encoded = identity?.passwordHash ?? (await dummyHashPromise);
      const passwordCorrect = await passwordHasher.verify(encoded, request.password);

      const audit = {
        tenantId: null,
        actorUserId: identity?.userId ?? null,
        action: "identity.sign_in",
        outcome: "denied",
        requestId: request.requestId,
        ipFingerprint: request.ipFingerprint,
      } as const;

      if (identity === undefined || !passwordCorrect) {
        await repository.recordFailure(audit, identity?.userId ?? null, lockout.threshold);
        throw authenticationFailed();
      }

      if (!accountMayReachSessionTransaction(identity.state, identity.lastFailedAuthAt)) {
        // Deliberately the same error as a wrong password. A locked account
        // answering differently confirms the address exists.
        await repository.recordFailure(
          { ...audit, outcome: "denied_state" },
          identity.userId,
          0,
        );
        throw authenticationFailed();
      }

      const refreshToken = refreshTokens.generate();
      const refreshExpiresAt = new Date(Date.now() + session.refreshTtlSeconds * 1_000);

      // Recheck identity state and PostgreSQL lock expiry in the session transaction.
      const sessionOutcome = await repository.createSession(
        {
          userId: identity.userId,
          tokenFamilyHash: refreshTokens.hash(refreshToken),
          expiresAt: refreshExpiresAt,
        },
        {
          ...audit,
          actorUserId: identity.userId,
          outcome: "accepted",
        },
        {
          allowExpiredLock: identity.state === "locked",
          verifiedPasswordHash: identity.passwordHash,
          lockoutWindowMs: lockout.windowMs,
        },
      );

      if (sessionOutcome.kind === "identity_unavailable") {
        // The account became unusable between the read and the write.
        await repository.recordFailure(
          { ...audit, outcome: "denied_state_race" },
          identity.userId,
          0,
        );
        throw authenticationFailed();
      }

      const sessionId = sessionOutcome.sessionId;

      // Issued only after the session row is committed. A token minted earlier
      // could outlive a rolled-back transaction and reference a session that
      // does not exist.
      const issued = await accessTokens.issue({
        userId: identity.userId,
        sessionId,
      });

      // Upgrade a hash created under a lower cost, now that the password is
      // known correct. Failure here must not fail the sign-in.
      if (passwordHasher.needsRehash(identity.passwordHash)) {
        try {
          await repository.updatePasswordHash(
            identity.userId,
            await passwordHasher.hash(request.password),
            identity.passwordHash,
          );
        } catch {
          // Intentionally ignored: the customer is authenticated either way.
        }
      }

      return {
        accessToken: issued.token,
        expiresInSeconds: issued.expiresInSeconds,
        csrfToken: csrf.issue(sessionId),
        refreshToken,
        refreshExpiresAt,
      };
    },
  };
}
