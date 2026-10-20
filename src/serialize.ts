// BYO_STUB: final owner N05. Signatures and output types are final (contracts.md); bodies are neutral.
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

/**
 * The customer view of a ticket. `viewerId` decides `unread`: true only when
 * the viewer is the requester and `requesterSeenAt` is null or older than
 * `lastMessageAt`.
 */
export function toCustomerTicket(
  row: SupportTicketRow,
  _viewerId: string,
): CustomerTicket {
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
    unread: false,
  };
}

/**
 * The customer view of a message, or `null` when customers must not see it
 * (notes, and event rows other than `status` and `merged`). `users` maps
 * author user ids to their summary (from `findUsersByIds`).
 */
export function toCustomerMessage(
  _row: SupportMessageRow,
  _users: ReadonlyMap<string, UserSummary>,
): CustomerMessage | null {
  return null;
}

/**
 * The agent view of a ticket. `extras.users` must hold the requester and
 * assignee (when set); `extras.tags` the ticket's tags.
 */
export function toAgentTicket(
  row: SupportTicketRow,
  extras: { users: ReadonlyMap<string, UserSummary>; tags: string[] },
): AgentTicket {
  return {
    id: row.id,
    number: row.number,
    subject: row.subject,
    status: row.status,
    priority: row.priority ?? null,
    channel: row.channel,
    userId: row.userId ?? null,
    requester: { id: null, name: null, email: null, image: null },
    organizationId: row.organizationId ?? null,
    visibility: row.visibility,
    assigneeId: row.assigneeId ?? null,
    assignee: null,
    rating: row.rating ?? null,
    verified: row.verified,
    mergedIntoId: row.mergedIntoId ?? null,
    requesterSeenAt: row.requesterSeenAt ?? null,
    agentSeenAt: row.agentSeenAt ?? null,
    lastMessageAt: row.lastMessageAt,
    solvedAt: row.solvedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    tags: extras.tags,
    unread: false,
  };
}

/** The agent view of a message. `users` maps author user ids to their summary. */
export function toAgentMessage(
  row: SupportMessageRow,
  _users: ReadonlyMap<string, UserSummary>,
): AgentMessage {
  return {
    id: row.id,
    ticketId: row.ticketId,
    kind: row.kind,
    authorType: row.authorType,
    userId: row.userId ?? null,
    author: null,
    body: row.body,
    data: row.data ?? null,
    mentions: row.mentions ?? [],
    channel: row.channel,
    verified: row.verified,
    emailMessageId: row.emailMessageId ?? null,
    createdAt: row.createdAt,
  };
}
