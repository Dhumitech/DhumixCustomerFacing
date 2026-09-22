import { useContext } from "react";
import { SessionContext, type SessionContextValue } from "./SessionProvider";

export function useSession(): SessionContextValue {
  const session = useContext(SessionContext);

  if (session === null) {
    throw new Error("useSession must be used inside SessionProvider.");
  }

  return session;
}
