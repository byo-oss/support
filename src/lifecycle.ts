import type { ByoPluginHooks } from "@byo-oss/core";
import { type AuthContext, getCurrentAdapter, type Where } from "better-auth";
import { createAuthMiddleware, isAPIError } from "better-auth/api";
import {
  type AuthWithContext,
  authRuntime,
  chunk,
  contextRuntime,
  findManyIn,
  IN_CHUNK,
  lowerEmail,
  type SupportRuntime,
  type SupportUserHook,
} from "./adapter";
import { runSweep } from "./delivery";
import type { ResolvedSupportOptions } from "./options";
import type { SupportAttachmentRow, SupportTicketRow } from "./schema";

/** The organization plugin paths support cleans up after. */
export const ORGANIZATION_CLEANUP_PATHS = [
  "/organization/delete",
  "/organization/remove-member",
  "/organization/leave",
] as const;

const PREFIX = "[@byo-oss/support]";

const inIds = (field: string, ids: readonly string[]) => [
  { field, operator: "in" as const, value: [...ids] },
];

/** The storage prefix that holds every blob of one organization's tickets. */
const orgPrefix = (organizationId: string) => `support/${organizationId}/`;

/**
 * "Deleting tickets": per chunk of ≤ 90 ids, deletes `supportDelivery`, then
 * blobs (`storage.delete`) and `supportAttachment`, then `supportMessage`,
 * then `supportTicketTag`, then `supportTicket`, and nulls any `mergedIntoId`
 * pointing at a deleted ticket. Never relies on cascades. Returns the number
 * of tickets deleted.
 */
export async function deleteTickets(
  rt: SupportRuntime,
  ticketIds: readonly string[],
): Promise<number> {
  const { adapter, opts } = rt;
  let deleted = 0;
  for (const part of chunk([...new Set(ticketIds)])) {
    // ids nobody has (already deleted, or never existed) are skipped, so a
    // delete below that removes nothing means something refused it
    const found = await adapter.findMany<Pick<SupportTicketRow, "id">>({
      model: "supportTicket",
      where: inIds("id", part),
      limit: IN_CHUNK,
      select: ["id"],
    });
    if (found.length === 0) continue;
    const ids = found.map((row) => row.id);

    // adapters without foreign keys (memory, MongoDB) cascade nothing, so
    // every child goes first, deepest first
    if (opts.mailer) {
      await adapter.deleteMany({
        model: "supportDelivery",
        where: inIds("ticketId", ids),
      });
    }
    if (opts.attachments) {
      const attachments = await findManyIn<
        Pick<SupportAttachmentRow, "id" | "storageKey">
      >(adapter, {
        model: "supportAttachment",
        field: "ticketId",
        values: ids,
        select: ["id", "storageKey"],
      });
      // blobs before rows: a failed blob delete leaves the row, so a retry
      // still finds the key
      for (const attachment of attachments) {
        if (attachment.storageKey) {
          await opts.attachments.storage.delete(attachment.storageKey);
        }
      }
      await adapter.deleteMany({
        model: "supportAttachment",
        where: inIds("ticketId", ids),
      });
    }
    await adapter.deleteMany({
      model: "supportMessage",
      where: inIds("ticketId", ids),
    });
    await adapter.deleteMany({
      model: "supportTicketTag",
      where: inIds("ticketId", ids),
    });
    await adapter.deleteMany({
      model: "supportTicket",
      where: inIds("id", ids),
    });
    // checked by reading back, not by deleteMany's count: some drivers
    // report 0 affected rows for a delete that worked
    const left = new Set(
      (
        await adapter.findMany<Pick<SupportTicketRow, "id">>({
          model: "supportTicket",
          where: inIds("id", ids),
          limit: IN_CHUNK,
          select: ["id"],
        })
      ).map((row) => row.id),
    );
    // a delete that matched rows but removed none (row-level security, a
    // trigger) would otherwise loop forever in the paged callers
    if (left.size === ids.length) {
      throw new Error(
        `${PREFIX} found ${ids.length} tickets to delete but deleted none`,
      );
    }
    const removed = ids.filter((id) => !left.has(id));
    await adapter.updateMany({
      model: "supportTicket",
      where: inIds("mergedIntoId", removed),
      update: { mergedIntoId: null },
    });
    deleted += removed.length;
  }
  return deleted;
}

/** Deletes every ticket matching one `eq` condition, a page of 90 at a time. */
async function deleteTicketsWhere(
  rt: SupportRuntime,
  field: "organizationId" | "requesterEmail",
  value: string,
): Promise<number> {
  let deleted = 0;
  for (;;) {
    const page = await rt.adapter.findMany<Pick<SupportTicketRow, "id">>({
      model: "supportTicket",
      where: [{ field, value }],
      limit: IN_CHUNK,
      select: ["id"],
    });
    if (page.length === 0) return deleted;
    // deleteTickets throws when it removes none of a page it found, so this
    // can't spin
    deleted += await deleteTickets(
      rt,
      page.map((row) => row.id),
    );
  }
}

/** Every blob stored under the organization's prefix, rows or no rows. */
async function deleteOrganizationBlobs(
  rt: SupportRuntime,
  organizationId: string,
): Promise<void> {
  await rt.opts.attachments?.storage.deletePrefix(orgPrefix(organizationId));
}

/**
 * Deletes an organization's tickets ("Deleting tickets", for adapters without
 * foreign keys) and always `storage.deletePrefix("support/<orgId>/")`, so it is
 * safe after the SQL cascade. Joins a caller's transaction
 * (`getCurrentAdapter`).
 */
export async function deleteOrganizationData(
  auth: AuthWithContext,
  organizationId: string,
): Promise<{ tickets: number }> {
  // an empty id must not reach deletePrefix("support//")
  if (!organizationId) {
    throw new Error(
      `${PREFIX} deleteOrganizationData: organizationId is empty`,
    );
  }
  const rt = await authRuntime(auth, "deleteOrganizationData");
  const tickets = await deleteTicketsWhere(
    rt,
    "organizationId",
    organizationId,
  );
  await deleteOrganizationBlobs(rt, organizationId);
  return { tickets };
}

/**
 * Applies `update` to every row matching `where` and returns how many
 * matched. Counted before the update, since some drivers report 0 affected
 * rows for an update that worked.
 */
async function clearMatching(
  rt: SupportRuntime,
  model: "supportTicket" | "supportMessage",
  where: Where[],
  update: Record<string, null>,
): Promise<number> {
  const matched = await rt.adapter.count({ model, where });
  if (matched > 0) await rt.adapter.updateMany({ model, where, update });
  return matched;
}

async function unassignStaffMember(
  rt: SupportRuntime,
  { userId, organizationId }: { userId: string; organizationId: string },
): Promise<number> {
  // teammate access in a customer org is checked live, and requesters keep
  // their own tickets, so only leaving the staff org changes anything
  if (!rt.opts.staffOrganizationId) return 0;
  if (organizationId !== rt.opts.staffOrganizationId) return 0;
  return clearMatching(
    rt,
    "supportTicket",
    [{ field: "assigneeId", value: userId }],
    { assigneeId: null },
  );
}

/**
 * A member left or was removed. In the staff organization: unassigns their
 * tickets. In a customer organization: changes nothing (teammate access is
 * checked live; requesters keep their own tickets).
 */
export async function deleteMemberData(
  auth: AuthWithContext,
  input: { userId: string; organizationId: string },
): Promise<{ unassigned: number }> {
  const rt = await authRuntime(auth, "deleteMemberData");
  return { unassigned: await unassignStaffMember(rt, input) };
}

/**
 * Erases an account-less person: deletes the tickets whose `requesterEmail`
 * is theirs ("Deleting tickets") and anonymizes their messages on other
 * tickets (`authorEmail`/`authorName` cleared). Email matched lowercased.
 */
export async function deleteSupportRequesterData(
  auth: AuthWithContext,
  input: { email: string },
): Promise<{ tickets: number; messages: number }> {
  const email = lowerEmail(input.email);
  if (!email) {
    throw new Error(`${PREFIX} deleteSupportRequesterData: email is empty`);
  }
  const rt = await authRuntime(auth, "deleteSupportRequesterData");
  const tickets = await deleteTicketsWhere(rt, "requesterEmail", email);
  // what's left carries their address on someone else's ticket
  const messages = await clearMatching(
    rt,
    "supportMessage",
    [{ field: "authorEmail", value: email }],
    { authorEmail: null, authorName: null },
  );
  return { tickets, messages };
}

type MemberRef = { userId: string; organizationId: string };

const memberRef = (value: unknown): MemberRef | undefined => {
  const member = value as Partial<MemberRef> | null | undefined;
  return typeof member?.userId === "string" &&
    typeof member.organizationId === "string"
    ? { userId: member.userId, organizationId: member.organizationId }
    : undefined;
};

/**
 * The plugin's `hooks.after`, always installed. Matches the three
 * organization paths; the handler returns early when
 * `ctx.context.returned` is an `APIError`, takes ids only from the response
 * (`returned.id` for delete, `returned.member` for remove-member, `returned`
 * for leave), runs `deleteOrganizationData` / `deleteMemberData` (row cleanup
 * only when `opts.organizationCleanup`; the blob `deletePrefix` on delete
 * always), and logs errors without failing the response.
 */
export function organizationHooksAfter(opts: ResolvedSupportOptions) {
  const paths = new Set<string>(ORGANIZATION_CLEANUP_PATHS);
  return [
    {
      matcher: (ctx: { path?: string }) => !!ctx.path && paths.has(ctx.path),
      handler: createAuthMiddleware(async (ctx) => {
        // better-auth runs after-hooks when the endpoint threw too: a refused
        // or unauthenticated call must change nothing
        const returned: unknown = ctx.context.returned;
        if (!ctx.path || isAPIError(returned)) return;
        // inside a better-auth transaction this is that transaction
        const rt: SupportRuntime = {
          context: ctx.context,
          adapter: await getCurrentAdapter(ctx.context.adapter),
          opts,
        };
        // the org change already happened; failing the response wouldn't
        // undo it, so every step logs and moves on
        const attempt = async (what: string, run: () => Promise<unknown>) => {
          try {
            await run();
          } catch (error) {
            ctx.context.logger.error(
              `${PREFIX} ${what} after ${ctx.path} failed`,
              error,
            );
          }
        };
        if (ctx.path === "/organization/delete") {
          const id = (returned as { id?: unknown } | null | undefined)?.id;
          if (typeof id !== "string" || !id) return;
          if (opts.organizationCleanup) {
            await attempt("ticket cleanup", () =>
              deleteTicketsWhere(rt, "organizationId", id),
            );
          }
          // always: on SQL the cascade already removed the rows, so the
          // prefix is the only way left to reach those blobs
          await attempt("blob cleanup", () => deleteOrganizationBlobs(rt, id));
          return;
        }
        if (!opts.organizationCleanup) return;
        const member = memberRef(
          ctx.path === "/organization/remove-member"
            ? (returned as { member?: unknown } | null | undefined)?.member
            : // leaving fires no organizationHooks, so only this hook covers it
              returned,
        );
        if (!member) return;
        await attempt("member cleanup", () => unassignStaffMember(rt, member));
      }),
    },
  ];
}

/**
 * `databaseHooks.user.delete.after`, built in `init` with its context: nulls
 * `userId` on tickets, messages, canned replies and attachments and
 * `assigneeId` on tickets, and clears `requesterEmail`/`requesterName`/
 * `authorEmail`/`authorName` equal to the deleted user's email. Logs and
 * swallows errors.
 */
export function userDeleteHook(
  context: AuthContext,
  opts: ResolvedSupportOptions,
): SupportUserHook {
  // the hook's own context argument can be null (outside an endpoint), so the
  // one captured in init is used
  return async (user) => {
    if (!user) return;
    try {
      const { adapter } = await contextRuntime(context, opts);
      // foreign keys do this on SQL; adapters without them (memory, MongoDB)
      // rely on this hook
      const clearUser = (model: string, field = "userId") =>
        adapter.updateMany({
          model,
          where: [{ field, value: user.id }],
          update: { [field]: null },
        });
      await clearUser("supportTicket");
      await clearUser("supportTicket", "assigneeId");
      await clearUser("supportMessage");
      await clearUser("supportCannedReply");
      if (opts.attachments) await clearUser("supportAttachment");

      // copies of their address from before the account was linked
      const email =
        typeof user.email === "string" ? lowerEmail(user.email) : "";
      if (!email) return;
      await adapter.updateMany({
        model: "supportTicket",
        where: [{ field: "requesterEmail", value: email }],
        update: { requesterEmail: null, requesterName: null },
      });
      await adapter.updateMany({
        model: "supportMessage",
        where: [{ field: "authorEmail", value: email }],
        update: { authorEmail: null, authorName: null },
      });
    } catch (error) {
      // the user is already gone; failing the delete wouldn't undo anything
      context.logger.error(
        `${PREFIX} clearing support data of deleted user ${user.id} failed`,
        error,
      );
    }
  };
}

/** The plugin's `byo` hooks for `@byo-oss/core`: `sweep` (`runSweep`), `deleteOrganizationData`, `deleteMemberData`. */
export function createByoHooks(_opts: ResolvedSupportOptions): ByoPluginHooks {
  return {
    sweep: (auth) => authRuntime(auth, "sweep").then((rt) => runSweep(rt)),
    deleteOrganizationData: async (auth, organizationId) => {
      await deleteOrganizationData(auth, organizationId);
    },
    deleteMemberData: async (auth, input) => {
      await deleteMemberData(auth, input);
    },
  };
}
