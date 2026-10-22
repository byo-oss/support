import type { Where } from "better-auth";
import {
  APIError,
  createAuthEndpoint,
  sessionMiddleware,
} from "better-auth/api";
import * as z from "zod";
import {
  defaultIsAgent,
  requireAgent,
  type SupportEndpointContext,
} from "../access";
import {
  endpointRuntime,
  findAll,
  findManyIn,
  findUsersByIds,
  type SupportRuntime,
} from "../adapter";
import {
  bindAttachments,
  listTicketAttachments,
  validateAttachments,
} from "../attachments";
import { cannedEndpoints } from "../canned";
import type {
  AgentMessageResponse,
  AgentTicketDetailResponse,
  AgentTicketListResponse,
  OkResponse,
  TagListResponse,
  UpdateTicketsResponse,
} from "../client";
import { enqueueReply } from "../delivery";
import { SUPPORT_ERROR_CODES } from "../error-codes";
import { emit, ticketEvent } from "../events";
import { resolveMergedTicket } from "../merge";
import { type ResolvedSupportOptions, SUPPORT_LIMITS } from "../options";
import { listAgentTickets } from "../queries";
import {
  type SupportEventData,
  type SupportMessageRow,
  type SupportTicketRow,
  type SupportTicketTagRow,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
} from "../schema";
import { toAgentMessage, toAgentTicket } from "../serialize";
import {
  addMessage,
  applyStatus,
  markSeen,
  normalizeTags,
  setTags,
} from "../tickets";

const byId = (id: string): Where[] => [{ field: "id", value: id }];

const notFound = () =>
  APIError.from("NOT_FOUND", SUPPORT_ERROR_CODES.TICKET_NOT_FOUND);

const notAnAgent = () =>
  APIError.from("BAD_REQUEST", SUPPORT_ERROR_CODES.NOT_AN_AGENT);

const statusSchema = z.enum(TICKET_STATUSES);
// tag text is checked by `normalizeTags` (400 `INVALID_TAG`)
const tagsSchema = z.array(z.string()).max(SUPPORT_LIMITS.ids);

// the ticket named by `id`, followed through merges (D2): every ticket-id
// endpoint works on the ticket it was merged into
async function loadResolvedTicket(
  rt: SupportRuntime,
  id: string,
): Promise<SupportTicketRow> {
  const ticket = await rt.adapter.findOne<SupportTicketRow>({
    model: "supportTicket",
    where: byId(id),
  });
  if (!ticket) throw notFound();
  return resolveMergedTicket(rt.adapter, ticket);
}

// `opts.isAgent`, or the staff-org check; every id must pass before any write
async function assertAgents(
  ctx: SupportEndpointContext,
  opts: ResolvedSupportOptions,
  userIds: readonly string[],
): Promise<void> {
  for (const userId of userIds) {
    const ok = opts.isAgent
      ? await opts.isAgent(userId)
      : await defaultIsAgent(ctx, opts, userId);
    if (!ok) throw notAnAgent();
  }
}

// tags of many tickets, keyed by ticket id and sorted (chunked `in` lists)
async function tagsByTicket(
  rt: SupportRuntime,
  ticketIds: readonly string[],
): Promise<Map<string, string[]>> {
  const rows = await findManyIn<SupportTicketTagRow>(rt.adapter, {
    model: "supportTicketTag",
    field: "ticketId",
    values: ticketIds,
  });
  const out = new Map<string, string[]>();
  for (const row of rows) {
    const tags = out.get(row.ticketId) ?? [];
    tags.push(row.tag);
    out.set(row.ticketId, tags);
  }
  for (const tags of out.values()) tags.sort();
  return out;
}

// oldest first; a status event written in the same millisecond as the reply
// that caused it sorts after the reply
const chronological = (a: SupportMessageRow, b: SupportMessageRow) =>
  new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() ||
  Number(a.kind === "event") - Number(b.kind === "event") ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// writes a `priority` or `assignee` change on one ticket and its event row
async function changeField(
  rt: SupportRuntime,
  input: {
    ticket: SupportTicketRow;
    field: "priority" | "assigneeId";
    to: string | null;
    actorId: string;
  },
): Promise<SupportTicketRow> {
  const { ticket, field, to, actorId } = input;
  const patch = { [field]: to, updatedAt: new Date() };
  const updated = await rt.adapter.update<SupportTicketRow>({
    model: "supportTicket",
    where: byId(ticket.id),
    update: patch,
  });
  const data: SupportEventData = {
    type: field === "priority" ? "priority" : "assignee",
    from: ticket[field] ?? null,
    to,
  };
  await addMessage(rt, {
    ticket,
    kind: "event",
    authorType: "agent",
    userId: actorId,
    body: "",
    data,
    channel: "web",
    verified: true,
    actorId,
  });
  return updated ?? ({ ...ticket, ...patch } as SupportTicketRow);
}

/**
 * The agent endpoints, keyed by `auth.api` key: `listSupportTickets`,
 * `getSupportTicketAsAgent`, `replyAsSupportAgent`, `updateSupportTickets`,
 * `markSupportTicketSeenAsAgent`, `listSupportTags`, plus the canned-reply
 * endpoints from `cannedEndpoints` in `../canned`. Leave the return type
 * inferred so `$InferServerPlugin` sees every endpoint. Every endpoint here
 * that takes a ticket id resolves it with `resolveMergedTicket` first and
 * works on the resolved ticket's id; the only ticket-id endpoints that don't
 * are `mergeSupportTickets` and `deleteSupportTickets`, which act on the ids
 * given.
 *
 * Each endpoint first calls `requireAgent` with exactly one action: `read`
 * for the queue, a ticket, mark-seen and tags; `reply` for replies and
 * notes; `update` for bulk updates.
 */
export function agentEndpoints(opts: ResolvedSupportOptions) {
  return {
    /**
     * The queue, newest `lastMessageAt` first, one page. Filters: `status`,
     * `assignee` (a user id, `"me"` or `"none"`), `tag`, `organizationId`,
     * `requesterId` (the requester's user id), `requesterEmail` (an
     * account-less requester) and `q` (`#123`/`123` exact number, else subject contains). Adds the
     * queue-wide `counts` and the server's `features`.
     */
    listSupportTickets: createAuthEndpoint(
      "/support/agent/tickets",
      {
        method: "GET",
        query: z
          .object({
            status: statusSchema.optional(),
            assignee: z.string().min(1).optional(),
            tag: z.string().max(SUPPORT_LIMITS.tagLength).optional(),
            organizationId: z.string().min(1).optional(),
            requesterId: z.string().min(1).optional(),
            requesterEmail: z
              .string()
              .min(1)
              .max(SUPPORT_LIMITS.email)
              .optional(),
            q: z.string().max(SUPPORT_LIMITS.q).optional(),
            cursor: z.string().max(SUPPORT_LIMITS.cursor).optional(),
          })
          .optional(),
        use: [sessionMiddleware],
      },
      async (ctx) => {
        const session = await requireAgent(
          ctx as SupportEndpointContext,
          opts,
          "read",
        );
        const rt = endpointRuntime(ctx, opts);
        const page = await listAgentTickets(rt, {
          viewerId: session.user.id,
          filters: ctx.query ?? {},
        });
        const ids = page.tickets.map((t) => t.id);
        const [tags, users] = await Promise.all([
          tagsByTicket(rt, ids),
          findUsersByIds(
            rt.adapter,
            page.tickets.flatMap((t) => [t.userId, t.assigneeId]),
          ),
        ]);
        return {
          tickets: page.tickets.map((row) =>
            toAgentTicket(row, { users, tags: tags.get(row.id) ?? [] }),
          ),
          nextCursor: page.nextCursor,
          counts: page.counts,
          features: opts.features,
        } satisfies AgentTicketListResponse;
      },
    ),

    /**
     * One ticket (followed through merges), every message (replies, notes
     * and events, oldest first) and every attached file.
     */
    getSupportTicketAsAgent: createAuthEndpoint(
      "/support/agent/ticket",
      {
        method: "GET",
        query: z.object({ id: z.string().min(1) }),
        use: [sessionMiddleware],
      },
      async (ctx) => {
        await requireAgent(ctx as SupportEndpointContext, opts, "read");
        const rt = endpointRuntime(ctx, opts);
        const ticket = await loadResolvedTicket(rt, ctx.query.id);
        const [rows, tagRows, attachments] = await Promise.all([
          findAll<SupportMessageRow>(rt.adapter, {
            model: "supportMessage",
            where: [{ field: "ticketId", value: ticket.id }],
            max: Number.MAX_SAFE_INTEGER,
          }),
          findAll<SupportTicketTagRow>(rt.adapter, {
            model: "supportTicketTag",
            where: [{ field: "ticketId", value: ticket.id }],
            max: SUPPORT_LIMITS.tagsListed,
          }),
          listTicketAttachments(rt, ticket.id, "agent"),
        ]);
        rows.sort(chronological);
        const users = await findUsersByIds(rt.adapter, [
          ticket.userId,
          ticket.assigneeId,
          ...rows.map((row) => row.userId),
        ]);
        const tags = [...new Set(tagRows.map((row) => row.tag))].sort();
        return {
          ticket: toAgentTicket(ticket, { users, tags }),
          messages: rows.map((row) => toAgentMessage(row, users)),
          attachments,
        } satisfies AgentTicketDetailResponse;
      },
    ),

    /**
     * An agent reply (`internal` false) or an internal note (`internal`
     * true) on the resolved ticket. A reply sets `status` (default
     * `pending`); a note changes it only when `status` is given. Every
     * mention must be an agent (`NOT_AN_AGENT`). Public replies are queued
     * for email.
     */
    replyAsSupportAgent: createAuthEndpoint(
      "/support/agent/reply",
      {
        method: "POST",
        body: z.object({
          ticketId: z.string().min(1),
          body: z
            .string()
            .min(1)
            .max(SUPPORT_LIMITS.body)
            .refine((value) => value.trim().length > 0),
          internal: z.boolean().optional(),
          status: statusSchema.optional(),
          mentions: z
            .array(z.string().min(1))
            .max(SUPPORT_LIMITS.mentions)
            .optional(),
          attachmentIds: z
            .array(z.string().min(1))
            .max(SUPPORT_LIMITS.attachmentIds)
            .optional(),
        }),
        use: [sessionMiddleware],
      },
      async (ctx) => {
        const gateCtx = ctx as SupportEndpointContext;
        const session = await requireAgent(gateCtx, opts, "reply");
        const rt = endpointRuntime(ctx, opts);
        const { body, internal, status, attachmentIds } = ctx.body;
        const ticket = await loadResolvedTicket(rt, ctx.body.ticketId);
        const mentions = [...new Set(ctx.body.mentions ?? [])];
        await assertAgents(gateCtx, opts, mentions);
        const kind = internal ? "note" : "reply";
        const actorId = session.user.id;

        const attachments = await validateAttachments(rt, {
          ticketId: ticket.id,
          uploaderId: actorId,
          attachmentIds,
          kind,
        });
        // addMessage applies the status itself; never applyStatus around it
        const result = await addMessage(rt, {
          ticket,
          kind,
          authorType: "agent",
          userId: actorId,
          body,
          mentions,
          channel: "web",
          verified: true,
          ...(status ? { status } : {}),
          actorId,
        });
        await bindAttachments(rt, {
          attachments,
          messageId: result.message.id,
        });
        if (kind === "reply") await enqueueReply(rt, result);

        const users = await findUsersByIds(rt.adapter, [actorId]);
        return {
          message: toAgentMessage(result.message, users),
        } satisfies AgentMessageResponse;
      },
    ),

    /**
     * Bulk update of 1–100 tickets (each followed through merges, deduped;
     * unknown ids ignored): `status`, `priority`, `assigneeId` (must be an
     * agent; null unassigns), `addTags`, `removeTags`. Every input is checked
     * before the first write. Returns `updated`: how many tickets matched
     * (after merge-follow and dedupe), including any the update left
     * unchanged.
     */
    updateSupportTickets: createAuthEndpoint(
      "/support/agent/update",
      {
        method: "POST",
        body: z.object({
          ids: z.array(z.string().min(1)).min(1).max(SUPPORT_LIMITS.ids),
          status: statusSchema.optional(),
          priority: z.enum(TICKET_PRIORITIES).nullable().optional(),
          assigneeId: z.string().min(1).nullable().optional(),
          addTags: tagsSchema.optional(),
          removeTags: tagsSchema.optional(),
        }),
        use: [sessionMiddleware],
      },
      async (ctx) => {
        const gateCtx = ctx as SupportEndpointContext;
        const session = await requireAgent(gateCtx, opts, "update");
        const rt = endpointRuntime(ctx, opts);
        const { ids, status, priority, assigneeId } = ctx.body;
        const actorId = session.user.id;

        // validate everything first, so a bad input never half-applies
        if (assigneeId) await assertAgents(gateCtx, opts, [assigneeId]);
        const addTags = ctx.body.addTags
          ? normalizeTags(ctx.body.addTags)
          : undefined;
        const removeTags = ctx.body.removeTags
          ? normalizeTags(ctx.body.removeTags)
          : undefined;

        const found = await findManyIn<SupportTicketRow>(rt.adapter, {
          model: "supportTicket",
          field: "id",
          values: ids,
        });
        const tickets = new Map<string, SupportTicketRow>();
        for (const row of found) {
          const resolved = await resolveMergedTicket(rt.adapter, row);
          tickets.set(resolved.id, resolved);
        }

        for (let ticket of tickets.values()) {
          if (status) {
            ticket = await applyStatus(rt, {
              ticket,
              to: status,
              actorId,
              authorType: "agent",
            });
          }
          if (
            priority !== undefined &&
            priority !== (ticket.priority ?? null)
          ) {
            ticket = await changeField(rt, {
              ticket,
              field: "priority",
              to: priority,
              actorId,
            });
          }
          const from = ticket.assigneeId ?? null;
          if (assigneeId !== undefined && assigneeId !== from) {
            ticket = await changeField(rt, {
              ticket,
              field: "assigneeId",
              to: assigneeId,
              actorId,
            });
            await emit(
              rt,
              ticketEvent("support.ticket.assigned", ticket, {
                actorId,
                ...(assigneeId ? { userId: assigneeId } : {}),
                data: { ticketId: ticket.id, from, to: assigneeId },
              }),
            );
          }
          if (addTags?.length || removeTags?.length) {
            await setTags(rt, {
              ticketId: ticket.id,
              add: addTags,
              remove: removeTags,
            });
          }
        }
        return { updated: tickets.size } satisfies UpdateTicketsResponse;
      },
    ),

    /** Marks the resolved ticket seen by the agents (`agentSeenAt` = now). */
    markSupportTicketSeenAsAgent: createAuthEndpoint(
      "/support/agent/mark-seen",
      {
        method: "POST",
        body: z.object({ id: z.string().min(1) }),
        use: [sessionMiddleware],
      },
      async (ctx) => {
        await requireAgent(ctx as SupportEndpointContext, opts, "read");
        const rt = endpointRuntime(ctx, opts);
        const ticket = await loadResolvedTicket(rt, ctx.body.id);
        await markSeen(rt, { ticketId: ticket.id, side: "agent" });
        return { ok: true } satisfies OkResponse;
      },
    ),

    /**
     * Every tag in use, deduped and sorted. Reads at most 10 000 tag rows
     * (`SUPPORT_LIMITS.tagsListed`); the adapter has no DISTINCT.
     */
    listSupportTags: createAuthEndpoint(
      "/support/agent/tags",
      {
        method: "GET",
        use: [sessionMiddleware],
      },
      async (ctx) => {
        await requireAgent(ctx as SupportEndpointContext, opts, "read");
        const rt = endpointRuntime(ctx, opts);
        const rows = await findAll<SupportTicketTagRow>(rt.adapter, {
          model: "supportTicketTag",
          where: [],
          max: SUPPORT_LIMITS.tagsListed,
        });
        const tags = [...new Set(rows.map((row) => row.tag))].sort();
        return tags satisfies TagListResponse;
      },
    ),

    ...cannedEndpoints(opts),
  };
}
