// BYO_STUB: final owner N10b. Signatures are final (contracts.md); bodies are neutral.
import type { AuthContext } from "better-auth";
import type { AuthWithContext, SupportUserHook } from "./adapter";
import type { ResolvedSupportOptions } from "./options";

/**
 * `databaseHooks.user.create.after` and `user.update.after`, built in `init`
 * with its context. When the user (non-null) has `emailVerified: true`, gives
 * them the `verified: true` tickets whose `requesterEmail` and the
 * `verified: true` messages whose `authorEmail` equal their lowercased email,
 * clearing the stored email and name. Logs and swallows errors.
 */
export function userLinkHooks(
  _context: AuthContext,
  _opts: ResolvedSupportOptions,
): { create: { after: SupportUserHook }; update: { after: SupportUserHook } } {
  const noop: SupportUserHook = async () => {};
  return { create: { after: noop }, update: { after: noop } };
}

/** Runs the same linking for one user on demand (e.g. after an import). */
export async function linkSupportRequester(
  _auth: AuthWithContext,
  _userId: string,
): Promise<{ tickets: number; messages: number }> {
  return { tickets: 0, messages: 0 };
}
