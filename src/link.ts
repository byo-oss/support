import type { AuthContext } from "better-auth";
import {
  type AuthWithContext,
  authRuntime,
  contextRuntime,
  findUserById,
  IN_CHUNK,
  lowerEmail,
  type SupportRuntime,
  type SupportUserHook,
} from "./adapter";
import type { ResolvedSupportOptions } from "./options";

type LinkTarget = { id: string; email: string; emailVerified: boolean };

/**
 * Gives `userId` every `verified: true` row of `model` whose `emailField`
 * equals `email`, clearing `emailField` and `nameField`. Works a chunk of
 * ids at a time: a linked row loses the email, so the next page moves on.
 * Returns the number of rows linked.
 */
async function linkRows(
  rt: SupportRuntime,
  {
    model,
    emailField,
    nameField,
    email,
    userId,
  }: {
    model: "supportTicket" | "supportMessage";
    emailField: string;
    nameField: string;
    email: string;
    userId: string;
  },
): Promise<number> {
  let linked = 0;
  // ids updated by the previous round; adapters don't report reliable update
  // counts (kysely on PGlite answers 0), so progress is checked by re-reading
  let previous = new Set<string>();
  for (;;) {
    const page = await rt.adapter.findMany<{ id: string }>({
      model,
      where: [
        { field: "verified", value: true },
        { field: emailField, value: email },
      ],
      limit: IN_CHUNK,
      select: ["id"],
    });
    if (page.length === 0) return linked;
    const ids = page.map((row) => row.id);
    // a linked row loses the email, so it can't match again; one that does
    // was not changed (row-level security, a trigger) and would loop forever
    if (ids.some((id) => previous.has(id))) {
      throw new Error(
        `[@byo-oss/support] ${model} rows to link were not updated`,
      );
    }
    await rt.adapter.updateMany({
      model,
      where: [{ field: "id", operator: "in", value: ids }],
      update: { userId, [emailField]: null, [nameField]: null },
    });
    linked += ids.length;
    previous = new Set(ids);
  }
}

/**
 * Links a verified user's account-less history: `verified: true` tickets
 * whose `requesterEmail` and `verified: true` messages whose `authorEmail`
 * equal their lowercased email. An unverified ticket is never linked, even
 * when verified messages were appended to it later.
 */
async function linkUser(
  rt: SupportRuntime,
  user: LinkTarget,
): Promise<{ tickets: number; messages: number }> {
  if (user.emailVerified !== true || !user.email) {
    return { tickets: 0, messages: 0 };
  }
  const email = lowerEmail(user.email);
  const tickets = await linkRows(rt, {
    model: "supportTicket",
    emailField: "requesterEmail",
    nameField: "requesterName",
    email,
    userId: user.id,
  });
  const messages = await linkRows(rt, {
    model: "supportMessage",
    emailField: "authorEmail",
    nameField: "authorName",
    email,
    userId: user.id,
  });
  return { tickets, messages };
}

/**
 * `databaseHooks.user.create.after` and `user.update.after`, built in `init`
 * with its context. When the user (non-null) has `emailVerified: true`, gives
 * them the `verified: true` tickets whose `requesterEmail` and the
 * `verified: true` messages whose `authorEmail` equal their lowercased email,
 * clearing the stored email and name. Logs and swallows errors.
 */
export function userLinkHooks(
  context: AuthContext,
  opts: ResolvedSupportOptions,
): { create: { after: SupportUserHook }; update: { after: SupportUserHook } } {
  // the hook's own context argument can be null (outside an endpoint), so the
  // one captured in init is used
  const link: SupportUserHook = async (user) => {
    if (user?.emailVerified !== true) return;
    try {
      await linkUser(await contextRuntime(context, opts), {
        id: user.id,
        email: user.email,
        emailVerified: user.emailVerified,
      });
    } catch (error) {
      // the user change already happened; failing it wouldn't undo anything
      context.logger.error(
        `[@byo-oss/support] linking tickets to user ${user.id} failed`,
        error,
      );
    }
  };
  return { create: { after: link }, update: { after: link } };
}

/**
 * Runs the same linking for one user on demand (e.g. after an import): their
 * `verified: true` tickets and messages sent from their address get their
 * `userId` and lose the stored email and name. Returns zeros for a missing
 * user or one whose email isn't verified. Inside a better-auth transaction
 * (`runWithTransaction`) it runs in that transaction.
 */
export async function linkSupportRequester(
  auth: AuthWithContext,
  userId: string,
): Promise<{ tickets: number; messages: number }> {
  const rt = await authRuntime(auth, "linkSupportRequester");
  const user = await findUserById(rt.adapter, userId);
  if (!user) return { tickets: 0, messages: 0 };
  return linkUser(rt, user);
}
