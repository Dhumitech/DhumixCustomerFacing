import {
  createContext,
  type PropsWithChildren,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import {
  authApi,
  DhumiApiError,
  type SignInRequest,
  type SignUpRequest,
} from "../api/auth";
import type { AuthAccepted, AuthSession } from "../api/generated";
import { tokenStore } from "./tokenStore";

export interface SessionContextValue {
  readonly session: AuthSession | null;
  readonly identityEmail: string | null;
  readonly isAuthenticated: boolean;
  signUp(input: SignUpRequest): Promise<AuthAccepted>;
  signIn(input: SignInRequest): Promise<AuthSession>;
  refresh(): Promise<AuthSession>;
  logout(): Promise<void>;
}

export const SessionContext = createContext<SessionContextValue | null>(null);

const MAX_REFRESH_MARGIN_MS = 60_000;
const REFRESH_LIFETIME_FRACTION = 0.9;

export function sessionRefreshDelayMs(expiresInSeconds: number): number {
  const lifetimeMs = Math.max(1_000, expiresInSeconds * 1_000);
  const refreshMarginMs = Math.min(
    MAX_REFRESH_MARGIN_MS,
    lifetimeMs * (1 - REFRESH_LIFETIME_FRACTION),
  );
  return Math.max(1_000, lifetimeMs - refreshMarginMs);
}

export function SessionProvider({ children }: PropsWithChildren) {
  const session = useSyncExternalStore(
    tokenStore.subscribe,
    tokenStore.getSnapshot,
    tokenStore.getSnapshot,
  );
  const identityEmail = useSyncExternalStore(
    tokenStore.subscribe,
    tokenStore.getIdentitySnapshot,
    tokenStore.getIdentitySnapshot,
  );

  useEffect(() => {
    if (session === null) {
      return;
    }

    let active = true;
    let transientRetryUsed = false;
    let timer: ReturnType<typeof setTimeout>;
    const expiresAt = Date.now() + Math.max(1_000, session.expires_in * 1_000);

    const scheduleExpiryClear = (): void => {
      timer = setTimeout(
        () => {
          if (active && tokenStore.getSnapshot() === session) {
            tokenStore.clear();
          }
        },
        Math.max(0, expiresAt - Date.now()),
      );
    };

    const refreshActiveSession = async (): Promise<void> => {
      try {
        await authApi.refresh();
      } catch (error) {
        if (!active) {
          return;
        }

        if (
          error instanceof DhumiApiError &&
          (error.status === 401 || error.status === 403)
        ) {
          tokenStore.clear();
          return;
        }

        // Preserve a still-valid access token after one transient failure. A
        // single bounded retry is scheduled before expiry; a second transient
        // failure clears the session exactly at expiry instead of leaving a
        // stale authenticated UI indefinitely.
        if (!transientRetryUsed) {
          transientRetryUsed = true;
          const remainingUntilExpiry = expiresAt - Date.now();
          if (remainingUntilExpiry <= 1_000) {
            scheduleExpiryClear();
          } else {
            timer = setTimeout(
              refreshActiveSession,
              Math.min(30_000, remainingUntilExpiry - 1_000),
            );
          }
        } else {
          scheduleExpiryClear();
        }
      }
    };

    timer = setTimeout(
      refreshActiveSession,
      sessionRefreshDelayMs(session.expires_in),
    );

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [session]);

  const value = useMemo<SessionContextValue>(
    () => ({
      session,
      identityEmail,
      isAuthenticated: session !== null,
      signUp: authApi.signUp,
      signIn: authApi.signIn,
      refresh: authApi.refresh,
      logout: authApi.logout,
    }),
    [identityEmail, session],
  );

  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}
