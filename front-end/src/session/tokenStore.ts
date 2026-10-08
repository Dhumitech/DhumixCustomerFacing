import type { AuthSession } from "../api/generated";

type Listener = () => void;

let currentSession: AuthSession | null = null;
let currentIdentityEmail: string | null = null;
let revision = 0;
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

export const tokenStore = Object.freeze({
  getRevision(): number { return revision; },
  getSnapshot(): AuthSession | null {
    return currentSession;
  },

  getIdentitySnapshot(): string | null {
    return currentIdentityEmail;
  },

  set(session: AuthSession, identityEmail?: string): void {
    revision += 1;
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
    revision += 1;
    currentIdentityEmail = null;
    notify();
  },

  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
});
