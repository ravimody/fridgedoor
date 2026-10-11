import { createContext, useContext } from 'react';
import type { Member } from '@fridgedoor/contracts';

/** The signed-in member and a way to sign out, for screens deep inside the app shell. */
export type SessionValue = { member?: Member | undefined; signOut: () => Promise<void> };
export const SessionContext = createContext<SessionValue>({ signOut: async () => undefined });
export const useSession = () => useContext(SessionContext);
