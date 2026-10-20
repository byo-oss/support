// BYO_STUB: final owner N06. Signatures are final (contracts.md); bodies are neutral.
import type { SupportRuntime } from "./adapter";
import type {
  AuthorType,
  MessageKind,
  SupportEventData,
  SupportMessageRow,
  SupportTicketRow,
  TicketChannel,
  TicketStatus,
  TicketVisibility,
} from "./schema";

const notBuilt = (name: string): never => {
  throw new Error(`[@byo-oss/support] ${name} is not built yet (BYO_STUB)`);
};

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

/**
 * Creates a ticket (`status: "open"`, a number from `allocateTicketNumber`
 * on the base adapter, a fresh `createReplyToken()`, `lastMessageAt` = now)
 * and then its first message (`kind: "reply"`, `authorType: "customer"`, same
 * channel, `verified` and `emailMessageId`). Retries the ticket insert with a
 * new number on a `number` unique conflict, at most 3 times. If the message
 * insert throws (e.g. a duplicate `emailMessageId`), deletes the ticket row
 * and rethrows the original error; the skipped number is acceptable. Emits
 * `support.ticket.created` only after both inserts succeeded. Never inside a
 * transaction. Trusts its caller for membership and visibility.
 */
export async function createTicket(
  _rt: SupportRuntime,
  _input: CreateTicketInput,
): Promise<{ ticket: SupportTicketRow; message: SupportMessageRow }> {
  return notBuilt("createTicket");
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
  _rt: SupportRuntime,
  _input: AddMessageInput,
): Promise<{ message: SupportMessageRow; ticket: SupportTicketRow }> {
  return notBuilt("addMessage");
}

/**
 * Sets `status` (and `solvedAt` when it becomes `solved`, null when it
 * becomes `open` or `pending`), writes a `status` event row
 * (`{ type: "status", from, to }`, `authorType` as given) and emits
 * `support.ticket.status_changed`. Same status: no write, no event. Does not
 * check who may make the change.
 */
export async function applyStatus(
  _rt: SupportRuntime,
  input: {
    ticket: SupportTicketRow;
    to: TicketStatus;
    actorId: string | null;
    authorType: AuthorType;
  },
): Promise<SupportTicketRow> {
  return input.ticket;
}

/** Sets `requesterSeenAt` or `agentSeenAt` to `at` (default now). */
export async function markSeen(
  _rt: SupportRuntime,
  _input: { ticketId: string; side: "requester" | "agent"; at?: Date },
): Promise<void> {}

/**
 * Trims, lowercases and dedupes tags. Throws 400 `INVALID_TAG` for a tag that
 * is empty, longer than 50 characters or outside `[a-z0-9_-]`.
 */
export function normalizeTags(tags: readonly string[]): string[] {
  return [...new Set(tags)];
}

/**
 * Adds and removes tags on a ticket (normalized; adding one it has is a
 * no-op) and returns its tags afterwards, sorted.
 */
export async function setTags(
  _rt: SupportRuntime,
  _input: { ticketId: string; add?: string[]; remove?: string[] },
): Promise<string[]> {
  return [];
}
