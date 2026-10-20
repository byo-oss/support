// BYO_STUB: final owner N10a. Signatures are final (contracts.md); bodies are neutral.
import type { ByoPluginHooks } from "@byo-oss/core";
import type { AuthContext } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import type {
  AuthWithContext,
  SupportRuntime,
  SupportUserHook,
} from "./adapter";
import type { ResolvedSupportOptions } from "./options";

/** The organization plugin paths support cleans up after. */
export const ORGANIZATION_CLEANUP_PATHS = [
  "/organization/delete",
  "/organization/remove-member",
  "/organization/leave",
] as const;

/**
 * "Deleting tickets": per chunk of ≤ 90 ids, deletes `supportDelivery`, then
 * blobs (`storage.delete`) and `supportAttachment`, then `supportMessage`,
 * then `supportTicketTag`, then `supportTicket`, and nulls any `mergedIntoId`
 * pointing at a deleted ticket. Never relies on cascades. Returns the number
 * of tickets deleted.
 */
export async function deleteTickets(
  _rt: SupportRuntime,
  _ticketIds: readonly string[],
): Promise<number> {
  return 0;
}

/**
 * Deletes an organization's tickets ("Deleting tickets", for adapters without
 * foreign keys) and always `storage.deletePrefix("support/<orgId>/")`, so it is
 * safe after the SQL cascade. Joins a caller's transaction
 * (`getCurrentAdapter`).
 */
export async function deleteOrganizationData(
  _auth: AuthWithContext,
  _organizationId: string,
): Promise<{ tickets: number }> {
  return { tickets: 0 };
}

/**
 * A member left or was removed. In the staff organization: unassigns their
 * tickets. In a customer organization: changes nothing (teammate access is
 * checked live; requesters keep their own tickets).
 */
export async function deleteMemberData(
  _auth: AuthWithContext,
  _input: { userId: string; organizationId: string },
): Promise<{ unassigned: number }> {
  return { unassigned: 0 };
}

/**
 * Erases an account-less person: deletes the tickets whose `requesterEmail`
 * is theirs ("Deleting tickets") and anonymizes their messages on other
 * tickets (`authorEmail`/`authorName` cleared). Email matched lowercased.
 */
export async function deleteSupportRequesterData(
  _auth: AuthWithContext,
  _input: { email: string },
): Promise<{ tickets: number; messages: number }> {
  return { tickets: 0, messages: 0 };
}

/**
 * The plugin's `hooks.after`, always installed. Matches the three
 * organization paths; the handler returns early when
 * `ctx.context.returned` is an `APIError`, takes ids only from the response
 * (`returned.id` for delete, `returned.member` for remove-member, `returned`
 * for leave), runs `deleteOrganizationData` / `deleteMemberData` (row cleanup
 * only when `opts.organizationCleanup`; the blob `deletePrefix` on delete
 * always), and logs errors without failing the response.
 */
export function organizationHooksAfter(_opts: ResolvedSupportOptions) {
  const paths = new Set<string>(ORGANIZATION_CLEANUP_PATHS);
  return [
    {
      matcher: (ctx: { path?: string }) => !!ctx.path && paths.has(ctx.path),
      handler: createAuthMiddleware(async () => {}),
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
  _context: AuthContext,
  _opts: ResolvedSupportOptions,
): SupportUserHook {
  return async () => {};
}

/** The plugin's `byo` hooks for `@byo-oss/core`: `sweep` (`runSweep`), `deleteOrganizationData`, `deleteMemberData`. */
export function createByoHooks(_opts: ResolvedSupportOptions): ByoPluginHooks {
  return {
    sweep: async () => ({ hasMore: false }),
    deleteOrganizationData: async () => {},
    deleteMemberData: async () => {},
  };
}
