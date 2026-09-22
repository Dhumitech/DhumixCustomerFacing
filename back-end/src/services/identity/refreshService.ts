import type { AccessTokenService } from "../../helpers/accessToken.js";
import type { CsrfService } from "../../helpers/csrf.js";
import type { RefreshTokenService } from "../../helpers/refreshToken.js";
import { ApplicationError } from "../../utils/applicationError.js";
import type { RefreshRepository } from "./refreshRepository.js";
import { csrfValidationFailed } from "./sessionErrors.js";

const REFRESH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface RefreshRequest {
  readonly refreshToken: string | undefined;
  readonly csrfToken: string | undefined;
  readonly requestId: string | null;
  readonly ipFingerprint: Buffer | null;
}

export interface RefreshResult {
  readonly accessToken: string;
  readonly expiresInSeconds: number;
  readonly csrfToken: string;
  readonly refreshToken: string;
  readonly refreshExpiresAt: Date;
}

export interface RefreshService {
  refresh(request: RefreshRequest): Promise<RefreshResult>;
}

export interface RefreshServiceDependencies {
  readonly repository: RefreshRepository;
  readonly accessTokens: AccessTokenService;
  readonly refreshTokens: RefreshTokenService;
  readonly csrf: CsrfService;
}

export function sessionRefreshFailed(): ApplicationError {
  return new ApplicationError({
    status: 401,
    code: "AUTHENTICATION_REQUIRED",
    title: "Session refresh failed",
    detail: "The browser session could not be refreshed.",
  });
}

function workspaceUnavailable(): ApplicationError {
  return new ApplicationError({
    status: 403,
    code: "ACCESS_DENIED",
    title: "Workspace unavailable",
    detail: "This account has no active workspace.",
  });
}

export function createRefreshService(
  dependencies: RefreshServiceDependencies,
): RefreshService {
  const { repository, accessTokens, refreshTokens, csrf } = dependencies;

  return {
    async refresh(request: RefreshRequest): Promise<RefreshResult> {
      if (
        request.refreshToken === undefined ||
        !REFRESH_TOKEN_PATTERN.test(request.refreshToken)
      ) {
        throw sessionRefreshFailed();
      }

      const presentedTokenHash = refreshTokens.hash(request.refreshToken);
      const sessionId = await repository.findSessionIdByTokenHash(presentedTokenHash);
      if (sessionId === undefined) {
        throw sessionRefreshFailed();
      }

      if (
        request.csrfToken === undefined ||
        !csrf.verify(sessionId, request.csrfToken)
      ) {
        throw csrfValidationFailed();
      }

      const replacementToken = refreshTokens.generate();
      const outcome = await repository.rotate({
        expectedSessionId: sessionId,
        presentedTokenHash,
        replacementTokenHash: refreshTokens.hash(replacementToken),
        requestId: request.requestId,
        ipFingerprint: request.ipFingerprint,
      });

      if (outcome.kind === "workspace_unavailable") {
        throw workspaceUnavailable();
      }
      if (outcome.kind !== "rotated") {
        throw sessionRefreshFailed();
      }

      const accessToken = await accessTokens.issue({
        userId: outcome.userId,
        sessionId: outcome.sessionId,
        tenantId: outcome.tenantId,
      });
      return {
        accessToken: accessToken.token,
        expiresInSeconds: accessToken.expiresInSeconds,
        csrfToken: csrf.issue(outcome.sessionId),
        refreshToken: replacementToken,
        refreshExpiresAt: outcome.refreshExpiresAt,
      };
    },
  };
}
