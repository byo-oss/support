import type { DBTransactionAdapter } from "better-auth";
import { APIError } from "better-auth/api";
import { chunk, findAll, lowerEmail, type SupportRuntime } from "./adapter";
import { allocateTicketNumber } from "./counter";
import { SUPPORT_ERROR_CODES } from "./error-codes";
import { emit, ticketEvent } from "./events";
import { SUPPORT_LIMITS } from "./options";
import type {
  AuthorType,
  MessageKind,
  SupportEventData,
  SupportMessageRow,
  SupportTicketRow,
  SupportTicketTagRow,
  TicketChannel,
  TicketStatus,
  TicketVisibility,
} from "./schema";
import { createReplyToken } from "./token";

/** Ticket inserts `createTicket` tries (a new number after each `number` conflict). */
const NUMBER_ATTEMPTS = 3;

export type CreateTicketInput = {
  subject: string;
  /** Body of the first message. */
  body: string;
  channel: TicketChannel;
  /** The requester's account. Set this or `requesterEmail`. */
  userId?: string | null;
  /** Account-less requester only (stored lowercased). */
  requesterEmail?: string | null;
  requesterName?: string | null;
  /** Already checked against `member` by the caller (N07); null for inbound. */
  organizationId?: string | null;
  /** @default "private" */
  visibility?: TicketVisibility;
  /** true for web; the creating message's DKIM result for email. */
  verified: boolean;
  /** Inbound mail's Message-ID, stored on the first message. */
  emailMessageId?: string | null;
  actorId: string | null;
};

type TicketData = Omit<SupportTicketRow, "id">;
type MessageData = Omit<SupportMessageRow, "id">;
type TagData = Omit<SupportTicketTagRow, "id">;

const byId = (id: string) => [{ field: "id", value: id }];

/** Best-effort logging for cleanup that must not mask the original error. */
function logError(rt: SupportRuntime, message: string, error: unknown): void {
  try {
    rt.context.logger.error(`[@byo-oss/support] ${message}`, error);
  } catch {
    // a broken logger must not change the outcome
  }
}

async function numberTaken(
  adapter: DBTransactionAdapter,
  number: number,
): Promise<boolean> {
  const row = await adapter.findOne<SupportTicketRow>({
    model: "supportTicket",
    where: [{ field: "number", value: number }],
  });
  return row !== null;
}

/**
 * Creates a ticket (`status: "open"`, a number from `allocateTicketNumber`
 * on the base adapter, a fresh `createReplyToken()`, `lastMessageAt` = now)
 * and then its first message (`kind: "reply"`, `authorType: "customer"`, same
 * channel, `verified` and `emailMessageId`). Retries the ticket insert with a
 * new number on a `number` unique conflict, at most 3 times. If the message
 * insert throws (e.g. a duplicate `emailMessageId`), deletes the ticket row
 * and rethrows the original error; the skipped number is acceptable. Emits
 * `support.ticket.created` only after both inserts succeeded. Never inside a
 * transaction. Trusts its caller for membership and visibility. A
 * `channel: "web"` create with a `userId` sets `requesterSeenAt = createdAt`;
 * email-created tickets leave it null.
 */
export async function createTicket(
  rt: SupportRuntime,
  input: CreateTicketInput,
): Promise<{ ticket: SupportTicketRow; message: SupportMessageRow }> {
  const now = new Date();
  const userId = input.userId ?? null;
  // requesterEmail/requesterName belong to account-less requesters only
  const email =
    !userId && input.requesterEmail ? lowerEmail(input.requesterEmail) : null;
  const name = !userId ? (input.requesterName ?? null) : null;

  let ticket: SupportTicketRow | undefined;
  for (let attempt = 1; !ticket; attempt++) {
    const number = await allocateTicketNumber(rt.adapter);
    const data: TicketData = {
      number,
      subject: input.subject,
      status: "open",
      priority: null,
      channel: input.channel,
      userId,
      requesterEmail: email,
      requesterName: name,
      organizationId: input.organizationId ?? null,
      visibility: input.visibility ?? "private",
      assigneeId: null,
      rating: null,
      verified: input.verified,
      mergedIntoId: null,
      replyToken: createReplyToken(),
      requesterSeenAt: input.channel === "web" && userId ? now : null,
      agentSeenAt: null,
      lastMessageAt: now,
      solvedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    try {
      ticket = await rt.adapter.create<TicketData, SupportTicketRow>({
        model: "supportTicket",
        data,
      });
    } catch (error) {
      // only a lost race on the number is worth another allocation
      if (
        attempt >= NUMBER_ATTEMPTS ||
        !(await numberTaken(rt.adapter, number))
      )
        throw error;
    }
  }

  let message: SupportMessageRow;
  try {
    message = await rt.adapter.create<MessageData, SupportMessageRow>({
      model: "supportMessage",
      data: {
        ticketId: ticket.id,
        kind: "reply",
        authorType: "customer",
        userId,
        authorEmail: email,
        authorName: name,
        body: input.body,
        data: null,
        mentions: null,
        emailMessageId: input.emailMessageId ?? null,
        channel: input.channel,
        verified: input.verified,
        createdAt: now,
      },
    });
  } catch (error) {
    try {
      await rt.adapter.delete({
        model: "supportTicket",
        where: byId(ticket.id),
      });
    } catch (cleanupError) {
      logError(
        rt,
        "could not remove the ticket of a failed create",
        cleanupError,
      );
    }
    throw error;
  }

  await emit(
    rt.opts,
    ticketEvent("support.ticket.created", ticket, {
      actorId: input.actorId,
      userId: ticket.userId,
      data: {
        ticketId: ticket.id,
        number: ticket.number,
        channel: ticket.channel,
        visibility: ticket.visibility,
      },
    }),
    rt.context.logger,
  );
  return { ticket, message };
}

export type AddMessageInput = {
  ticket: SupportTicketRow;
  kind: MessageKind;
  authorType: AuthorType;
  userId?: string | null;
  /** Account-less sender only (stored lowercased). */
  authorEmail?: string | null;
  authorName?: string | null;
  body: string;
  /** `event` rows only. */
  data?: SupportEventData | null;
  /** Agent replies and notes only; already checked with `isAgent`. */
  mentions?: string[];
  channel: TicketChannel;
  verified: boolean;
  emailMessageId?: string | null;
  /**
   * Agent reply or note: the status to set. Replies default to `pending`;
   * notes keep the status when omitted. Callers never call `applyStatus`
   * around `addMessage`.
   */
  status?: TicketStatus;
  actorId: string | null;
};

/**
 * Appends a message and applies what it implies:
 * - `reply`/`note` on a `closed` ticket: 400 `TICKET_CLOSED` (nothing written).
 * - The message is inserted FIRST, before any ticket update, status change or
 *   event, so a failed insert (duplicate `emailMessageId`) changes nothing.
 * - A `reply` bumps `lastMessageAt` and `updatedAt` (notes and events don't,
 *   so customers never see activity they can't read).
 * - Only a `channel: "web"` reply whose `userId === ticket.userId` sets
 *   `requesterSeenAt`; email replies never do (the sweep must still mail an
 *   unseen agent reply). An agent reply or note sets `agentSeenAt`.
 * - Customer reply on `pending` or `solved` → `open`. Agent reply →
 *   `input.status ?? "pending"`. Agent note → `input.status` when given.
 *   All through `applyStatus`; event rows never transition.
 * - Events: `support.customer.replied`, `support.agent.replied`,
 *   `support.note.added`, plus one `support.agent.mentioned` per mention.
 * Returns the message and the ticket as it is after the write.
 */
export async function addMessage(
  rt: SupportRuntime,
  input: AddMessageInput,
): Promise<{ message: SupportMessageRow; ticket: SupportTicketRow }> {
  const { kind, authorType } = input;
  const isEvent = kind === "event";
  const isReply = kind === "reply";
  if (!isEvent && input.ticket.status === "closed")
    throw APIError.from("BAD_REQUEST", SUPPORT_ERROR_CODES.TICKET_CLOSED);

  const now = new Date();
  const userId = input.userId ?? null;
  const agentMessage = authorType === "agent" && !isEvent;
  const mentions = agentMessage ? [...new Set(input.mentions ?? [])] : [];

  // The first write: a failed insert (duplicate Message-ID) leaves the ticket
  // and the event stream exactly as they were.
  const message = await rt.adapter.create<MessageData, SupportMessageRow>({
    model: "supportMessage",
    data: {
      ticketId: input.ticket.id,
      kind,
      authorType,
      userId,
      authorEmail:
        !userId && input.authorEmail ? lowerEmail(input.authorEmail) : null,
      authorName: input.authorName ?? null,
      body: input.body,
      data: isEvent ? (input.data ?? null) : null,
      mentions: mentions.length > 0 ? mentions : null,
      emailMessageId: input.emailMessageId ?? null,
      channel: input.channel,
      verified: input.verified,
      createdAt: now,
    },
  });
  if (isEvent) return { message, ticket: input.ticket };

  const patch: Partial<TicketData> = {};
  if (isReply) {
    patch.lastMessageAt = now;
    patch.updatedAt = now;
    if (
      input.channel === "web" &&
      userId !== null &&
      userId === input.ticket.userId
    )
      patch.requesterSeenAt = now;
  }
  if (agentMessage) patch.agentSeenAt = now;

  let ticket = input.ticket;
  if (Object.keys(patch).length > 0) {
    const updated = await rt.adapter.update<SupportTicketRow>({
      model: "supportTicket",
      where: byId(ticket.id),
      update: patch,
    });
    ticket = updated ?? { ...ticket, ...patch };
  }

  let to: TicketStatus | undefined;
  if (authorType === "customer") {
    if (isReply && (ticket.status === "pending" || ticket.status === "solved"))
      to = "open";
  } else if (agentMessage) {
    to = isReply ? (input.status ?? "pending") : input.status;
  }
  if (to) {
    ticket = await applyStatus(rt, {
      ticket,
      to,
      actorId: input.actorId,
      authorType,
    });
  }

  const logger = rt.context.logger;
  const ids = { ticketId: ticket.id, messageId: message.id };
  if (authorType === "customer" && isReply) {
    await emit(
      rt.opts,
      ticketEvent("support.customer.replied", ticket, {
        actorId: input.actorId,
        userId: ticket.userId,
        data: { ...ids, channel: input.channel },
      }),
      logger,
    );
  } else if (agentMessage && isReply) {
    await emit(
      rt.opts,
      ticketEvent("support.agent.replied", ticket, {
        actorId: input.actorId,
        userId: ticket.userId,
        data: { ...ids, status: ticket.status },
      }),
      logger,
    );
  } else if (agentMessage) {
    await emit(
      rt.opts,
      ticketEvent("support.note.added", ticket, {
        actorId: input.actorId,
        data: ids,
      }),
      logger,
    );
  }
  for (const mentioned of mentions) {
    await emit(
      rt.opts,
      ticketEvent("support.agent.mentioned", ticket, {
        actorId: input.actorId,
        userId: mentioned,
        data: { ...ids, kind },
      }),
      logger,
    );
  }
  return { message, ticket };
}

/**
 * Sets `status` (and `solvedAt` when it becomes `solved`, null when it
 * becomes `open` or `pending`), writes a `status` event row
 * (`{ type: "status", from, to }`, `authorType` as given) and emits
 * `support.ticket.status_changed`. Same status: no write, no event. Does not
 * check who may make the change.
 */
export async function applyStatus(
  rt: SupportRuntime,
  input: {
    ticket: SupportTicketRow;
    to: TicketStatus;
    actorId: string | null;
    authorType: AuthorType;
  },
): Promise<SupportTicketRow> {
  const { ticket, to } = input;
  const from = ticket.status;
  if (from === to) return ticket;

  const now = new Date();
  const patch: Partial<TicketData> = { status: to, updatedAt: now };
  if (to === "solved") patch.solvedAt = now;
  else if (to !== "closed") patch.solvedAt = null;

  const updated = await rt.adapter.update<SupportTicketRow>({
    model: "supportTicket",
    where: byId(ticket.id),
    update: patch,
  });
  await rt.adapter.create<MessageData, SupportMessageRow>({
    model: "supportMessage",
    data: {
      ticketId: ticket.id,
      kind: "event",
      authorType: input.authorType,
      userId: input.actorId,
      authorEmail: null,
      authorName: null,
      body: "",
      data: { type: "status", from, to },
      mentions: null,
      emailMessageId: null,
      channel: "web",
      verified: true,
      createdAt: now,
    },
  });

  const next = updated ?? { ...ticket, ...patch };
  await emit(
    rt.opts,
    ticketEvent("support.ticket.status_changed", next, {
      actorId: input.actorId,
      userId: next.userId,
      data: { ticketId: next.id, from, to },
    }),
    rt.context.logger,
  );
  return next;
}

/** Sets `requesterSeenAt` or `agentSeenAt` to `at` (default now). */
export async function markSeen(
  rt: SupportRuntime,
  input: { ticketId: string; side: "requester" | "agent"; at?: Date },
): Promise<void> {
  const at = input.at ?? new Date();
  await rt.adapter.update({
    model: "supportTicket",
    where: byId(input.ticketId),
    update:
      input.side === "requester"
        ? { requesterSeenAt: at }
        : { agentSeenAt: at },
  });
}

const TAG_PATTERN = /^[a-z0-9_-]+$/;

/**
 * Trims, lowercases and dedupes tags. Throws 400 `INVALID_TAG` for a tag that
 * is empty, longer than 50 characters or outside `[a-z0-9_-]`.
 */
export function normalizeTags(tags: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of tags) {
    const tag = raw.trim().toLowerCase();
    if (
      tag.length === 0 ||
      tag.length > SUPPORT_LIMITS.tagLength ||
      !TAG_PATTERN.test(tag)
    )
      throw APIError.from("BAD_REQUEST", SUPPORT_ERROR_CODES.INVALID_TAG);
    out.add(tag);
  }
  return [...out];
}

/**
 * Adds and removes tags on a ticket (normalized; adding one it has is a
 * no-op) and returns its tags afterwards, sorted. A tag named in both lists
 * ends up removed.
 */
export async function setTags(
  rt: SupportRuntime,
  input: { ticketId: string; add?: string[]; remove?: string[] },
): Promise<string[]> {
  // validate both lists before the first write
  const add = normalizeTags(input.add ?? []);
  const remove = new Set(normalizeTags(input.remove ?? []));

  const rows = await findAll<SupportTicketTagRow>(rt.adapter, {
    model: "supportTicketTag",
    where: [{ field: "ticketId", value: input.ticketId }],
    max: SUPPORT_LIMITS.tagsListed,
  });
  const existing = new Set(rows.map((row) => row.tag));

  const doomed = rows.filter((row) => remove.has(row.tag));
  for (const ids of chunk(doomed.map((row) => row.id))) {
    await rt.adapter.deleteMany({
      model: "supportTicketTag",
      where: [{ field: "id", operator: "in", value: ids }],
    });
  }

  const final = new Set(existing);
  for (const tag of remove) final.delete(tag);
  for (const tag of add) {
    if (existing.has(tag) || remove.has(tag)) continue;
    await rt.adapter.create<TagData, SupportTicketTagRow>({
      model: "supportTicketTag",
      data: { ticketId: input.ticketId, tag },
    });
    final.add(tag);
  }
  return [...final].sort();
}
