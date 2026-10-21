import {
  APIError,
  createAuthEndpoint,
  sessionMiddleware,
} from "better-auth/api";
import * as z from "zod";
import { checkSession, requireCustomer } from "../access";
import {
  endpointRuntime,
  findAll,
  findMember,
  findUsersByIds,
  type SupportRuntime,
  type UserSummary,
} from "../adapter";
import {
  bindAttachments,
  listTicketAttachments,
  validateAttachments,
} from "../attachments";
import type {
  CustomerMessageResponse,
  CustomerTicketDetailResponse,
  CustomerTicketListResponse,
  CustomerTicketResponse,
  OkResponse,
} from "../client";
import { SUPPORT_ERROR_CODES } from "../error-codes";
import { resolveMergedTicket } from "../merge";
import {
  type ResolvedSupportOptions,
  SUPPORT_LIMITS,
  type SupportSession,
} from "../options";
import { listCustomerTickets } from "../queries";
import {
  type SupportMessageRow,
  type SupportTicketRow,
  TICKET_STATUSES,
  type TicketRating,
  type TicketStatus,
  type TicketVisibility,
} from "../schema";
import {
  type CustomerMessage,
  toCustomerMessage,
  toCustomerTicket,
} from "../serialize";
import { addMessage, applyStatus, createTicket, markSeen } from "../tickets";

// ---------------------------------------------------------------------------
// Input (limits from SUPPORT_LIMITS)
// ---------------------------------------------------------------------------

const VISIBILITIES = [
  "private",
  "organization",
] as const satisfies readonly TicketVisibility[];
const RATINGS = ["good", "bad"] as const satisfies readonly TicketRating[];
/** The only statuses a requester may ask for: solve and reopen. */
const REQUESTER_STATUSES = [
  "solved",
  "open",
] as const satisfies readonly TicketStatus[];
type RequesterStatus = (typeof REQUESTER_STATUSES)[number];

const idSchema = z.string().min(1);
const bodySchema = z.string().min(1).max(SUPPORT_LIMITS.body);

const createBodySchema = z.object({
  subject: z.string().trim().min(1).max(SUPPORT_LIMITS.subject),
  body: bodySchema,
  organizationId: idSchema.optional(),
  visibility: z.enum(VISIBILITIES).optional(),
});

const listQuerySchema = z
  .object({
    status: z.enum(TICKET_STATUSES).optional(),
    organizationId: idSchema.optional(),
    q: z.string().max(SUPPORT_LIMITS.q).optional(),
    cursor: z.string().max(SUPPORT_LIMITS.cursor).optional(),
  })
  .optional();

const replyBodySchema = z.object({
  ticketId: idSchema,
  body: bodySchema,
  attachmentIds: z.array(idSchema).max(SUPPORT_LIMITS.attachmentIds).optional(),
});

const updateMineBodySchema = z.object({
  id: idSchema,
  status: z.enum(REQUESTER_STATUSES).optional(),
  visibility: z.enum(VISIBILITIES).optional(),
  rating: z.enum(RATINGS).optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const notAllowed = () =>
  APIError.from("FORBIDDEN", SUPPORT_ERROR_CODES.NOT_ALLOWED);
const notAMember = () =>
  APIError.from("FORBIDDEN", SUPPORT_ERROR_CODES.NOT_A_MEMBER);
const ticketClosed = () =>
  APIError.from("BAD_REQUEST", SUPPORT_ERROR_CODES.TICKET_CLOSED);

/**
 * The ticket a ticket-id endpoint acts on (D2): the named ticket, followed
 * through `mergedIntoId`. Null when it doesn't exist; the caller's gate then
 * answers 404 `TICKET_NOT_FOUND`.
 */
async function loadResolvedTicket(
  rt: SupportRuntime,
  id: string,
): Promise<SupportTicketRow | null> {
  const ticket = await rt.adapter.findOne<SupportTicketRow>({
    model: "supportTicket",
    where: [{ field: "id", value: id }],
  });
  return ticket ? resolveMergedTicket(rt.adapter, ticket) : null;
}

// the caller as a message author, straight from the session (no user query)
const sessionAuthor = (session: SupportSession): Map<string, UserSummary> =>
  new Map([
    [
      session.user.id,
      {
        id: session.user.id,
        name: session.user.name,
        email: session.user.email,
        emailVerified: session.user.emailVerified,
        image: session.user.image ?? null,
      },
    ],
  ]);

/** A customer's own reply, which the customer serializer always shows. */
function ownReply(
  row: SupportMessageRow,
  users: ReadonlyMap<string, UserSummary>,
): CustomerMessage {
  const message = toCustomerMessage(row, users);
  if (!message) {
    throw new Error("[@byo-oss/support] a customer reply was serialized away");
  }
  return message;
}

// oldest first; within one millisecond a reply comes before the status event
// it caused (`addMessage` inserts the message first), then by id
const KIND_ORDER: Record<SupportMessageRow["kind"], number> = {
  reply: 0,
  note: 1,
  event: 2,
};
const timelineOrder = (a: SupportMessageRow, b: SupportMessageRow): number =>
  new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() ||
  KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Every message of a ticket that the customer may see, oldest first. */
async function customerTimeline(
  rt: SupportRuntime,
  ticketId: string,
): Promise<CustomerMessage[]> {
  // paged by id with an explicit limit on every query, ordered by time here
  const rows = await findAll<SupportMessageRow>(rt.adapter, {
    model: "supportMessage",
    where: [{ field: "ticketId", value: ticketId }],
    max: Number.MAX_SAFE_INTEGER,
  });
  // notes never reach a customer, so their authors aren't even looked up
  const candidates = rows.filter((row) => row.kind !== "note");
  candidates.sort(timelineOrder);
  const users = await findUsersByIds(
    rt.adapter,
    candidates.map((row) => row.userId),
  );
  const messages: CustomerMessage[] = [];
  for (const row of candidates) {
    const message = toCustomerMessage(row, users);
    if (message) messages.push(message);
  }
  return messages;
}

/**
 * A requester's status change (D9). On `closed`: 400 `TICKET_CLOSED`. Same
 * status: null (a no-op). `solved` only from `open`/`pending`, `open` only
 * from `solved`; anything else: 400 `INVALID_STATUS_TRANSITION`.
 */
function requesterTransition(
  from: TicketStatus,
  to: RequesterStatus,
): RequesterStatus | null {
  if (from === "closed") throw ticketClosed();
  if (from === to) return null;
  const allowed =
    to === "solved" ? from === "open" || from === "pending" : from === "solved";
  if (!allowed) {
    throw APIError.from(
      "BAD_REQUEST",
      SUPPORT_ERROR_CODES.INVALID_STATUS_TRANSITION,
    );
  }
  return to;
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/**
 * The customer endpoints, keyed by `auth.api` key: `createSupportTicket`,
 * `listMySupportTickets`, `getSupportTicket`, `replyToSupportTicket`,
 * `updateMySupportTicket`, `markSupportTicketSeen`. Leave the return type
 * inferred so `$InferServerPlugin` sees every endpoint. Every endpoint that takes a ticket id resolves
 * it with `resolveMergedTicket` first, re-applies the access rule to the
 * resolved ticket, and works on the resolved ticket's id.
 */
export function customerEndpoints(opts: ResolvedSupportOptions) {
  return {
    /**
     * Opens a ticket as the signed-in user (`channel: "web"`, verified).
     * `organizationId` must be one of the caller's organizations (403
     * `NOT_A_MEMBER`); `visibility: "organization"` needs an
     * `organizationId` (403 `NOT_ALLOWED`). Default visibility: `private`.
     */
    createSupportTicket: createAuthEndpoint(
      "/support/create-ticket",
      { method: "POST", body: createBodySchema, use: [sessionMiddleware] },
      async (ctx) => {
        const session = await checkSession(ctx, opts, "customer");
        const rt = endpointRuntime(ctx, opts);
        const me = session.user.id;
        const { subject, body, organizationId, visibility } = ctx.body;
        if (visibility === "organization" && !organizationId) {
          throw notAllowed();
        }
        if (organizationId) {
          const member = await findMember(rt.adapter, {
            userId: me,
            organizationId,
          });
          if (!member) throw notAMember();
        }
        const { ticket } = await createTicket(rt, {
          subject,
          body,
          channel: "web",
          userId: me,
          organizationId: organizationId ?? null,
          visibility: visibility ?? "private",
          verified: true,
          actorId: me,
        });
        return {
          ticket: toCustomerTicket(ticket, me),
        } satisfies CustomerTicketResponse;
      },
    ),

    /**
     * The caller's own tickets plus those shared with an organization they
     * are a current member of, newest activity first, one page at a time.
     */
    listMySupportTickets: createAuthEndpoint(
      "/support/my-tickets",
      { method: "GET", query: listQuerySchema, use: [sessionMiddleware] },
      async (ctx) => {
        const session = await checkSession(ctx, opts, "customer");
        const me = session.user.id;
        const page = await listCustomerTickets(endpointRuntime(ctx, opts), {
          userId: me,
          filters: ctx.query ?? {},
        });
        return {
          tickets: page.tickets.map((row) => toCustomerTicket(row, me)),
          nextCursor: page.nextCursor,
          features: { attachments: opts.features.attachments },
        } satisfies CustomerTicketListResponse;
      },
    ),

    /**
     * One ticket (followed through merges) with the messages and attachments
     * customers may see. Missing or not visible: 404 `TICKET_NOT_FOUND`.
     */
    getSupportTicket: createAuthEndpoint(
      "/support/ticket",
      {
        method: "GET",
        query: z.object({ id: idSchema }),
        use: [sessionMiddleware],
      },
      async (ctx) => {
        const rt = endpointRuntime(ctx, opts);
        const { session, ticket } = await requireCustomer(
          ctx,
          opts,
          await loadResolvedTicket(rt, ctx.query.id),
          "read",
        );
        const messages = await customerTimeline(rt, ticket.id);
        const attachments = await listTicketAttachments(
          rt,
          ticket.id,
          "customer",
        );
        return {
          ticket: toCustomerTicket(ticket, session.user.id),
          messages,
          attachments,
        } satisfies CustomerTicketDetailResponse;
      },
    ),

    /**
     * Replies as the requester, or as a teammate who can see the ticket.
     * `closed`: 400 `TICKET_CLOSED`. A reply on `pending` or `solved`
     * reopens the ticket.
     */
    replyToSupportTicket: createAuthEndpoint(
      "/support/reply",
      { method: "POST", body: replyBodySchema, use: [sessionMiddleware] },
      async (ctx) => {
        const rt = endpointRuntime(ctx, opts);
        const { session, ticket } = await requireCustomer(
          ctx,
          opts,
          await loadResolvedTicket(rt, ctx.body.ticketId),
          "reply",
        );
        // before the attachment checks, so a closed ticket says so first
        if (ticket.status === "closed") throw ticketClosed();
        const me = session.user.id;
        const attachments = await validateAttachments(rt, {
          ticketId: ticket.id,
          uploaderId: me,
          attachmentIds: ctx.body.attachmentIds,
          kind: "reply",
        });
        const { message } = await addMessage(rt, {
          ticket,
          kind: "reply",
          authorType: "customer",
          userId: me,
          body: ctx.body.body,
          channel: "web",
          verified: true,
          actorId: me,
        });
        await bindAttachments(rt, { attachments, messageId: message.id });
        return {
          message: ownReply(message, sessionAuthor(session)),
        } satisfies CustomerMessageResponse;
      },
    ),

    /**
     * The requester solves or reopens, shares or unshares, and rates their
     * ticket. A teammate: 403 `NOT_ALLOWED`. Every rule is checked before
     * anything is written.
     */
    updateMySupportTicket: createAuthEndpoint(
      "/support/update-mine",
      { method: "POST", body: updateMineBodySchema, use: [sessionMiddleware] },
      async (ctx) => {
        const rt = endpointRuntime(ctx, opts);
        const { session, ticket } = await requireCustomer(
          ctx,
          opts,
          await loadResolvedTicket(rt, ctx.body.id),
          "requester",
        );
        const me = session.user.id;
        const { status, visibility, rating } = ctx.body;

        const to = status ? requesterTransition(ticket.status, status) : null;
        const share =
          visibility !== undefined && visibility !== ticket.visibility
            ? visibility
            : undefined;
        if (share === "organization") {
          if (!ticket.organizationId) throw notAllowed();
          // current membership: a requester who left can't share again
          const member = await findMember(rt.adapter, {
            userId: me,
            organizationId: ticket.organizationId,
          });
          if (!member) throw notAMember();
        }
        const rate =
          rating !== undefined && rating !== ticket.rating ? rating : undefined;

        let current = ticket;
        if (to) {
          current = await applyStatus(rt, {
            ticket: current,
            to,
            actorId: me,
            authorType: "customer",
          });
        }
        if (share !== undefined || rate !== undefined) {
          const patch: Partial<SupportTicketRow> = { updatedAt: new Date() };
          if (share !== undefined) patch.visibility = share;
          if (rate !== undefined) patch.rating = rate;
          const updated = await rt.adapter.update<SupportTicketRow>({
            model: "supportTicket",
            where: [{ field: "id", value: current.id }],
            update: patch,
          });
          current = updated ?? { ...current, ...patch };
        }
        return {
          ticket: toCustomerTicket(current, me),
        } satisfies CustomerTicketResponse;
      },
    ),

    /** The requester has seen the ticket up to now. A teammate: 403 `NOT_ALLOWED`. */
    markSupportTicketSeen: createAuthEndpoint(
      "/support/mark-seen",
      {
        method: "POST",
        body: z.object({ id: idSchema }),
        use: [sessionMiddleware],
      },
      async (ctx) => {
        const rt = endpointRuntime(ctx, opts);
        const { ticket } = await requireCustomer(
          ctx,
          opts,
          await loadResolvedTicket(rt, ctx.body.id),
          "requester",
        );
        await markSeen(rt, { ticketId: ticket.id, side: "requester" });
        return { ok: true } satisfies OkResponse;
      },
    ),
  };
}
