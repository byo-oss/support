import type { UserSummary } from "./adapter";
import type {
  AuthorType,
  SupportEventData,
  SupportMessageRow,
  SupportTicketRow,
  TicketChannel,
  TicketPriority,
  TicketRating,
  TicketStatus,
  TicketVisibility,
} from "./schema";

/** A person as customers see them: agents and teammates by name and avatar only. */
export type PublicAuthor = { name: string | null; image: string | null };

/** A ticket as customers see it. Nothing else is ever returned to a customer. */
export type CustomerTicket = {
  id: string;
  number: number;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority | null;
  channel: TicketChannel;
  organizationId: string | null;
  visibility: TicketVisibility;
  rating: TicketRating | null;
  createdAt: Date;
  updatedAt: Date;
  lastMessageAt: Date;
  solvedAt: Date | null;
  /** The viewer is the requester and has not seen the latest reply. Always false for teammates. */
  unread: boolean;
};

/**
 * A message as customers see it: `reply` rows, and `event` rows whose
 * `data.type` is `status` or `merged`. `data` is set on event rows only.
 */
export type CustomerMessage = {
  id: string;
  ticketId: string;
  kind: "reply" | "event";
  authorType: AuthorType;
  /** Null for system rows. Account-less senders show `authorName`. */
  author: PublicAuthor | null;
  body: string;
  data: SupportEventData | null;
  createdAt: Date;
};

/** A ticket as agents see it. Never includes `replyToken`. */
export type AgentTicket = {
  id: string;
  number: number;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority | null;
  channel: TicketChannel;
  userId: string | null;
  /** The requester: the account (name, email, image), or the account-less sender's stored email and name. */
  requester: {
    id: string | null;
    name: string | null;
    email: string | null;
    image: string | null;
  };
  organizationId: string | null;
  visibility: TicketVisibility;
  assigneeId: string | null;
  assignee: { id: string; name: string; image: string | null } | null;
  rating: TicketRating | null;
  verified: boolean;
  mergedIntoId: string | null;
  requesterSeenAt: Date | null;
  agentSeenAt: Date | null;
  lastMessageAt: Date;
  solvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  tags: string[];
  /** `agentSeenAt` is null or older than `lastMessageAt`. */
  unread: boolean;
};

/** A message as agents see it: every kind, with mentions and verification. */
export type AgentMessage = {
  id: string;
  ticketId: string;
  kind: "reply" | "note" | "event";
  authorType: AuthorType;
  userId: string | null;
  author: {
    id: string | null;
    name: string | null;
    email: string | null;
    image: string | null;
  } | null;
  body: string;
  data: SupportEventData | null;
  mentions: string[];
  channel: TicketChannel;
  verified: boolean;
  emailMessageId: string | null;
  createdAt: Date;
};

// D5: unread when the side's seen mark is missing or older than the last reply
const seenBefore = (
  seenAt: Date | null | undefined,
  lastMessageAt: Date,
): boolean =>
  !seenAt || new Date(seenAt).getTime() < new Date(lastMessageAt).getTime();

// customers see only status and merged events in the timeline
const CUSTOMER_EVENT_TYPES: ReadonlySet<SupportEventData["type"]> = new Set([
  "status",
  "merged",
]);

/**
 * The customer view of a ticket. `viewerId` decides `unread`: true only when
 * the viewer is the requester and `requesterSeenAt` is null or older than
 * `lastMessageAt`.
 */
export function toCustomerTicket(
  row: SupportTicketRow,
  viewerId: string,
): CustomerTicket {
  const isRequester = !!row.userId && row.userId === viewerId;
  return {
    id: row.id,
    number: row.number,
    subject: row.subject,
    status: row.status,
    priority: row.priority ?? null,
    channel: row.channel,
    organizationId: row.organizationId ?? null,
    visibility: row.visibility,
    rating: row.rating ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastMessageAt: row.lastMessageAt,
    solvedAt: row.solvedAt ?? null,
    unread: isRequester && seenBefore(row.requesterSeenAt, row.lastMessageAt),
  };
}

/**
 * The customer view of a message, or `null` when customers must not see it
 * (notes, and event rows other than `status` and `merged`). `users` maps
 * author user ids to their summary (from `findUsersByIds`).
 */
export function toCustomerMessage(
  row: SupportMessageRow,
  users: ReadonlyMap<string, UserSummary>,
): CustomerMessage | null {
  if (row.kind === "note") return null;
  if (row.kind === "event") {
    if (!row.data || !CUSTOMER_EVENT_TYPES.has(row.data.type)) return null;
  }
  return {
    id: row.id,
    ticketId: row.ticketId,
    kind: row.kind,
    authorType: row.authorType,
    author: publicAuthor(row, users),
    body: row.body,
    data: row.kind === "event" && row.data ? eventData(row.data) : null,
    createdAt: row.createdAt,
  };
}

// only the event's own keys, so nothing else stored in `data` reaches customers
function eventData(data: SupportEventData): SupportEventData {
  const out: SupportEventData = { type: data.type };
  if (data.from !== undefined) out.from = data.from;
  if (data.to !== undefined) out.to = data.to;
  return out;
}

// agents and teammates by name and avatar only; an account-less sender by the
// name they gave (never their address); system rows have no author
function publicAuthor(
  row: SupportMessageRow,
  users: ReadonlyMap<string, UserSummary>,
): PublicAuthor | null {
  if (row.authorType === "system") return null;
  const user = row.userId ? users.get(row.userId) : undefined;
  if (user) return { name: user.name, image: user.image };
  return { name: row.authorName ?? null, image: null };
}

/**
 * The agent view of a ticket. `extras.users` must hold the requester and
 * assignee (when set); `extras.tags` the ticket's tags.
 */
export function toAgentTicket(
  row: SupportTicketRow,
  extras: { users: ReadonlyMap<string, UserSummary>; tags: string[] },
): AgentTicket {
  const { users, tags } = extras;
  const account = row.userId ? users.get(row.userId) : undefined;
  const assignee = row.assigneeId ? users.get(row.assigneeId) : undefined;
  return {
    id: row.id,
    number: row.number,
    subject: row.subject,
    status: row.status,
    priority: row.priority ?? null,
    channel: row.channel,
    userId: row.userId ?? null,
    requester: account
      ? {
          id: account.id,
          name: account.name,
          email: account.email,
          image: account.image,
        }
      : {
          id: row.userId ?? null,
          name: row.requesterName ?? null,
          email: row.requesterEmail ?? null,
          image: null,
        },
    organizationId: row.organizationId ?? null,
    visibility: row.visibility,
    assigneeId: row.assigneeId ?? null,
    assignee: assignee
      ? { id: assignee.id, name: assignee.name, image: assignee.image }
      : null,
    rating: row.rating ?? null,
    verified: row.verified,
    mergedIntoId: row.mergedIntoId ?? null,
    requesterSeenAt: row.requesterSeenAt ?? null,
    agentSeenAt: row.agentSeenAt ?? null,
    lastMessageAt: row.lastMessageAt,
    solvedAt: row.solvedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    tags: [...tags],
    unread: seenBefore(row.agentSeenAt, row.lastMessageAt),
  };
}

/** The agent view of a message. `users` maps author user ids to their summary. */
export function toAgentMessage(
  row: SupportMessageRow,
  users: ReadonlyMap<string, UserSummary>,
): AgentMessage {
  const user = row.userId ? users.get(row.userId) : undefined;
  let author: AgentMessage["author"] = null;
  if (user) {
    author = {
      id: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
    };
  } else if (row.userId || row.authorEmail || row.authorName) {
    author = {
      id: row.userId ?? null,
      name: row.authorName ?? null,
      email: row.authorEmail ?? null,
      image: null,
    };
  }
  return {
    id: row.id,
    ticketId: row.ticketId,
    kind: row.kind,
    authorType: row.authorType,
    userId: row.userId ?? null,
    author,
    body: row.body,
    data: row.data ?? null,
    mentions: [...(row.mentions ?? [])],
    channel: row.channel,
    verified: row.verified,
    emailMessageId: row.emailMessageId ?? null,
    createdAt: row.createdAt,
  };
}
