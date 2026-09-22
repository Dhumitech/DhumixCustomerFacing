import type { AuthSession } from "../api/generated";

type Listener = () => void;

let currentSession: AuthSession | null = null;
let currentIdentityEmail: string | null = null;
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

export const tokenStore = Object.freeze({
  getSnapshot(): AuthSession | null {
    return currentSession;
  },

  getIdentitySnapshot(): string | null {
    return currentIdentityEmail;
  },

  set(session: AuthSession, identityEmail?: string): void {
    currentSession = Object.freeze({ ...session });
    if (identityEmail !== undefined) {
      currentIdentityEmail = identityEmail.trim().toLocaleLowerCase();
    }
    notify();
  },

  clear(): void {
    if (currentSession === null) {
      return;
    }

    currentSession = null;
    currentIdentityEmail = null;
    notify();
  },

  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
});
