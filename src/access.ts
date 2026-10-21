import type { DBTransactionAdapter, GenericEndpointContext } from "better-auth";
import { APIError } from "better-auth/api";
import {
  hasPermission,
  type OrganizationOptions,
} from "better-auth/plugins/organization";
import { findMember, listMemberships } from "./adapter";
import { SUPPORT_ERROR_CODES } from "./error-codes";
import type {
  ResolvedSupportOptions,
  SupportAuthorizeInput,
  SupportSession,
} from "./options";
import type { SupportTicketRow } from "./schema";
import type { SupportAction } from "./statements";

/** An endpoint context whose `context.session` was set by `sessionMiddleware` (or not). */
export type SupportEndpointContext = GenericEndpointContext & {
  context: { session?: SupportSession | null };
};

/** What a customer may do on a ticket. */
export type CustomerNeed = "read" | "reply" | "requester";

/** How the caller relates to a ticket they can see. */
export type CustomerRole = "requester" | "teammate";

// the organization plugin's own options, so `hasPermission` sees the app's
// `ac`, `roles`, `creatorRole` and dynamic access control
function organizationOptions(
  ctx: SupportEndpointContext,
): OrganizationOptions | undefined {
  const plugin = ctx.context.options.plugins?.find(
    (p) => p.id === "organization",
  ) as { options?: OrganizationOptions } | undefined;
  return plugin?.options;
}

// a member of `organizationId` whose role grants `permissions`; never looks
// at role names, and never at the session's active organization
async function memberHasPermission(
  ctx: SupportEndpointContext,
  input: {
    userId: string;
    organizationId: string | undefined;
    permissions: Record<string, string[]>;
  },
): Promise<boolean> {
  const { userId, organizationId, permissions } = input;
  if (!organizationId) return false;
  const options = organizationOptions(ctx);
  if (!options) return false;
  const member = await findMember(ctx.context.adapter, {
    userId,
    organizationId,
  });
  if (!member) return false;
  return hasPermission(
    { role: member.role, options, permissions, organizationId },
    ctx,
  );
}

/**
 * The default `authorize`: looks up the caller's `member` row in
 * `input.organizationId` (the staff org) with `findMember`, and checks its
 * role with the organization plugin's `hasPermission`, passing the org
 * plugin's own options from `ctx.context.options.plugins`. No org id or no
 * member row: false.
 */
export async function defaultAuthorize(
  ctx: SupportEndpointContext,
  _opts: ResolvedSupportOptions,
  input: SupportAuthorizeInput,
): Promise<boolean> {
  return memberHasPermission(ctx, {
    userId: input.session.user.id,
    organizationId: input.organizationId,
    permissions: input.permissions,
  });
}

/**
 * The default `isAgent`: `userId` is a member of `staffOrganizationId` whose
 * role has `support: ["read"]`. False without a staff org.
 */
export async function defaultIsAgent(
  ctx: SupportEndpointContext,
  opts: ResolvedSupportOptions,
  userId: string,
): Promise<boolean> {
  return memberHasPermission(ctx, {
    userId,
    organizationId: opts.staffOrganizationId,
    permissions: { support: ["read"] },
  });
}

/**
 * Reads the session from `ctx.context.session` (401 `UNAUTHORIZED` when
 * absent) and asks `opts.acceptSession` with `kind`; refused: 403
 * `SESSION_NOT_ACCEPTED`. Returns the session.
 */
export async function checkSession(
  ctx: SupportEndpointContext,
  opts: ResolvedSupportOptions,
  kind: "customer" | "agent",
): Promise<SupportSession> {
  const session = ctx.context.session;
  if (!session) throw APIError.fromStatus("UNAUTHORIZED");
  const accepted = await opts.acceptSession({
    session,
    headers: ctx.headers ?? new Headers(),
    kind,
  });
  if (!accepted) {
    throw APIError.from("FORBIDDEN", SUPPORT_ERROR_CODES.SESSION_NOT_ACCEPTED);
  }
  return session;
}

/**
 * Gate for every agent endpoint: `checkSession(ctx, opts, "agent")`, then
 * `opts.authorize` (or `defaultAuthorize`) with
 * `{ session, headers, organizationId: opts.staffOrganizationId, permissions: { support: actions } }`.
 * Denied: 403 `NOT_ALLOWED`. Returns the session.
 */
export async function requireAgent(
  ctx: SupportEndpointContext,
  opts: ResolvedSupportOptions,
  action: SupportAction | SupportAction[],
): Promise<SupportSession> {
  const session = await checkSession(ctx, opts, "agent");
  const input: SupportAuthorizeInput = {
    session,
    headers: ctx.headers ?? new Headers(),
    // always the staff org, never a ticket's: a customer org's owner is not
    // an agent on their own org's tickets
    organizationId: opts.staffOrganizationId,
    permissions: { support: Array.isArray(action) ? [...action] : [action] },
  };
  const allowed = opts.authorize
    ? await opts.authorize(input)
    : await defaultAuthorize(ctx, opts, input);
  if (!allowed) {
    throw APIError.from("FORBIDDEN", SUPPORT_ERROR_CODES.NOT_ALLOWED);
  }
  return session;
}

/**
 * Gate for customer endpoints on one ticket. Pass the ticket after
 * `resolveMergedTicket`. Runs `checkSession(ctx, opts, "customer")`, then the
 * read rule: the caller is the requester (`ticket.userId`), or the ticket is
 * `visibility: "organization"` and the caller is a current member of its
 * `organizationId`. A null or invisible ticket: 404 `TICKET_NOT_FOUND`.
 * `need: "requester"` and the caller is only a teammate: 403 `NOT_ALLOWED`.
 */
export async function requireCustomer(
  ctx: SupportEndpointContext,
  opts: ResolvedSupportOptions,
  ticket: SupportTicketRow | null,
  need: CustomerNeed,
): Promise<{
  session: SupportSession;
  ticket: SupportTicketRow;
  role: CustomerRole;
}> {
  const session = await checkSession(ctx, opts, "customer");
  const notFound = () =>
    APIError.from("NOT_FOUND", SUPPORT_ERROR_CODES.TICKET_NOT_FOUND);
  if (!ticket) throw notFound();
  const userId = session.user.id;
  // the requester keeps access after leaving the organization
  if (ticket.userId && ticket.userId === userId) {
    return { session, ticket, role: "requester" };
  }
  if (ticket.visibility !== "organization" || !ticket.organizationId) {
    throw notFound();
  }
  const member = await findMember(ctx.context.adapter, {
    userId,
    organizationId: ticket.organizationId,
  });
  if (!member) throw notFound();
  // a teammate may read and reply, nothing only the requester may do
  if (need === "requester") {
    throw APIError.from("FORBIDDEN", SUPPORT_ERROR_CODES.NOT_ALLOWED);
  }
  return { session, ticket, role: "teammate" };
}

/** The ids of the organizations `userId` is a member of (`listMemberships`, limit 1000). */
export async function myOrganizationIds(
  adapter: DBTransactionAdapter,
  userId: string,
): Promise<string[]> {
  const memberships = await listMemberships(adapter, userId);
  return [...new Set(memberships.map((m) => m.organizationId))];
}
