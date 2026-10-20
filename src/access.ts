// BYO_STUB: final owner N05. Signatures are final (contracts.md); bodies are neutral and fail closed.
import type { DBTransactionAdapter, GenericEndpointContext } from "better-auth";
import { APIError } from "better-auth/api";
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

/**
 * The default `authorize`: looks up the caller's `member` row in
 * `input.organizationId` (the staff org) with `findMember`, and checks its
 * role with the organization plugin's `hasPermission`, passing the org
 * plugin's own options from `ctx.context.options.plugins`. No org id or no
 * member row: false.
 */
export async function defaultAuthorize(
  _ctx: SupportEndpointContext,
  _opts: ResolvedSupportOptions,
  _input: SupportAuthorizeInput,
): Promise<boolean> {
  return false;
}

/**
 * The default `isAgent`: `userId` is a member of `staffOrganizationId` whose
 * role has `support: ["read"]`. False without a staff org.
 */
export async function defaultIsAgent(
  _ctx: SupportEndpointContext,
  _opts: ResolvedSupportOptions,
  _userId: string,
): Promise<boolean> {
  return false;
}

/**
 * Reads the session from `ctx.context.session` (401 `UNAUTHORIZED` when
 * absent) and asks `opts.acceptSession` with `kind`; refused: 403
 * `SESSION_NOT_ACCEPTED`. Returns the session.
 */
export async function checkSession(
  ctx: SupportEndpointContext,
  _opts: ResolvedSupportOptions,
  _kind: "customer" | "agent",
): Promise<SupportSession> {
  const session = ctx.context.session;
  if (!session) throw APIError.fromStatus("UNAUTHORIZED");
  throw APIError.from("FORBIDDEN", SUPPORT_ERROR_CODES.SESSION_NOT_ACCEPTED);
}

/**
 * Gate for every agent endpoint: `checkSession(ctx, opts, "agent")`, then
 * `opts.authorize` (or `defaultAuthorize`) with
 * `{ session, headers, organizationId: opts.staffOrganizationId, permissions: { support: actions } }`.
 * Denied: 403 `NOT_ALLOWED`. Returns the session.
 */
export async function requireAgent(
  _ctx: SupportEndpointContext,
  _opts: ResolvedSupportOptions,
  _action: SupportAction | SupportAction[],
): Promise<SupportSession> {
  throw APIError.from("FORBIDDEN", SUPPORT_ERROR_CODES.NOT_ALLOWED);
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
  _ctx: SupportEndpointContext,
  _opts: ResolvedSupportOptions,
  _ticket: SupportTicketRow | null,
  _need: CustomerNeed,
): Promise<{
  session: SupportSession;
  ticket: SupportTicketRow;
  role: CustomerRole;
}> {
  throw APIError.from("NOT_FOUND", SUPPORT_ERROR_CODES.TICKET_NOT_FOUND);
}

/** The ids of the organizations `userId` is a member of (`listMemberships`, limit 1000). */
export async function myOrganizationIds(
  _adapter: DBTransactionAdapter,
  _userId: string,
): Promise<string[]> {
  return [];
}
