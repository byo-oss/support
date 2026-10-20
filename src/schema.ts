import type { BetterAuthPlugin } from "better-auth";

type PluginSchema = NonNullable<BetterAuthPlugin["schema"]>;

// Field order inside each model and model order inside the schema matter for
// SQL migrations: a referenced table must be created first.

const supportTicket = {
  fields: {
    number: { type: "number", required: true, unique: true },
    subject: { type: "string", required: true },
    status: { type: "string", required: true, index: true },
    priority: { type: "string", required: false },
    channel: { type: "string", required: true },
    userId: {
      type: "string",
      required: false,
      index: true,
      references: { model: "user", field: "id", onDelete: "set null" },
    },
    requesterEmail: { type: "string", required: false, index: true },
    requesterName: { type: "string", required: false },
    organizationId: {
      type: "string",
      required: false,
      index: true,
      references: { model: "organization", field: "id", onDelete: "cascade" },
    },
    visibility: { type: "string", required: true },
    assigneeId: {
      type: "string",
      required: false,
      index: true,
      references: { model: "user", field: "id", onDelete: "set null" },
    },
    rating: { type: "string", required: false },
    verified: { type: "boolean", required: true },
    mergedIntoId: {
      type: "string",
      required: false,
      index: true,
      references: { model: "supportTicket", field: "id", onDelete: "set null" },
    },
    replyToken: { type: "string", required: true, unique: true },
    requesterSeenAt: { type: "date", required: false },
    agentSeenAt: { type: "date", required: false },
    lastMessageAt: { type: "date", required: true, index: true },
    solvedAt: { type: "date", required: false },
    createdAt: { type: "date", required: true },
    updatedAt: { type: "date", required: true },
  },
} as const;

const supportCounter = {
  fields: {
    key: { type: "string", required: true, unique: true },
    value: { type: "number", required: true },
  },
} as const;

const supportTicketTag = {
  fields: {
    ticketId: {
      type: "string",
      required: true,
      index: true,
      references: { model: "supportTicket", field: "id", onDelete: "cascade" },
    },
    tag: { type: "string", required: true, index: true },
  },
} as const;

const supportMessage = {
  fields: {
    ticketId: {
      type: "string",
      required: true,
      index: true,
      references: { model: "supportTicket", field: "id", onDelete: "cascade" },
    },
    kind: { type: "string", required: true },
    authorType: { type: "string", required: true },
    userId: {
      type: "string",
      required: false,
      index: true,
      references: { model: "user", field: "id", onDelete: "set null" },
    },
    authorEmail: { type: "string", required: false, index: true },
    authorName: { type: "string", required: false },
    body: { type: "string", required: true },
    data: { type: "json", required: false },
    mentions: { type: "json", required: false },
    emailMessageId: { type: "string", required: false, unique: true },
    channel: { type: "string", required: true },
    verified: { type: "boolean", required: true },
    createdAt: { type: "date", required: true, index: true },
  },
} as const;

const supportCannedReply = {
  fields: {
    title: { type: "string", required: true },
    body: { type: "string", required: true },
    userId: {
      type: "string",
      required: false,
      index: true,
      references: { model: "user", field: "id", onDelete: "set null" },
    },
    createdAt: { type: "date", required: true },
    updatedAt: { type: "date", required: true },
  },
} as const;

const supportDelivery = {
  fields: {
    messageId: {
      type: "string",
      required: true,
      index: true,
      references: { model: "supportMessage", field: "id", onDelete: "cascade" },
    },
    ticketId: {
      type: "string",
      required: true,
      index: true,
      references: { model: "supportTicket", field: "id", onDelete: "cascade" },
    },
    status: { type: "string", required: true, index: true },
    scheduledFor: { type: "date", required: true, index: true },
    claimedAt: { type: "date", required: false },
    attempts: { type: "number", required: true, defaultValue: 0 },
    detail: { type: "string", required: false },
    providerId: { type: "string", required: false },
    createdAt: { type: "date", required: true },
  },
} as const;

const supportAttachment = {
  fields: {
    ticketId: {
      type: "string",
      required: true,
      index: true,
      references: { model: "supportTicket", field: "id", onDelete: "cascade" },
    },
    messageId: {
      type: "string",
      required: false,
      index: true,
      references: { model: "supportMessage", field: "id", onDelete: "cascade" },
    },
    userId: {
      type: "string",
      required: false,
      index: true,
      references: { model: "user", field: "id", onDelete: "set null" },
    },
    internal: { type: "boolean", required: true },
    filename: { type: "string", required: true },
    contentType: { type: "string", required: true },
    size: { type: "number", required: true },
    storageKey: { type: "string", required: true },
    createdAt: { type: "date", required: true, index: true },
  },
} as const;

/** Every model support can declare, for typing `options.schema`. */
export const fullSchema = {
  supportTicket,
  supportCounter,
  supportTicketTag,
  supportMessage,
  supportCannedReply,
  supportDelivery,
  supportAttachment,
} satisfies PluginSchema;

export type SupportSchema = typeof fullSchema;

/** The models that exist on every install. */
export type SupportCoreSchema = Omit<
  SupportSchema,
  "supportDelivery" | "supportAttachment"
>;

/**
 * The plugin schema for these options: the five core models, plus
 * `supportDelivery` only with `mailer` and `supportAttachment` only with
 * `attachments`.
 */
export function buildSchema(features: {
  mailer?: unknown;
  attachments?: unknown;
}): SupportCoreSchema &
  Partial<Pick<SupportSchema, "supportDelivery" | "supportAttachment">> {
  // a fresh copy per plugin instance: mergeSchema writes renames into it
  return structuredClone({
    supportTicket,
    supportCounter,
    supportTicketTag,
    supportMessage,
    supportCannedReply,
    ...(features.mailer ? { supportDelivery } : {}),
    ...(features.attachments ? { supportAttachment } : {}),
  });
}

export type TicketStatus = "open" | "pending" | "solved" | "closed";
export type TicketPriority = "low" | "normal" | "high" | "urgent";
export type TicketChannel = "web" | "email";
export type TicketVisibility = "private" | "organization";
export type TicketRating = "good" | "bad";
export type MessageKind = "reply" | "note" | "event";
export type AuthorType = "customer" | "agent" | "system";
export type DeliveryStatus =
  | "pending"
  | "sending"
  | "sent"
  | "skipped"
  | "failed";

export const TICKET_STATUSES = ["open", "pending", "solved", "closed"] as const;
export const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;

/** `data` on an `event` message. */
export type SupportEventData = {
  type:
    | "status"
    | "assignee"
    | "priority"
    | "merged"
    | "attachment_dropped"
    | "followup_of";
  from?: string | null;
  to?: string | null;
};

export type SupportTicketRow = {
  id: string;
  number: number;
  subject: string;
  status: TicketStatus;
  priority?: TicketPriority | null;
  channel: TicketChannel;
  userId?: string | null;
  requesterEmail?: string | null;
  requesterName?: string | null;
  organizationId?: string | null;
  visibility: TicketVisibility;
  assigneeId?: string | null;
  rating?: TicketRating | null;
  verified: boolean;
  mergedIntoId?: string | null;
  replyToken: string;
  requesterSeenAt?: Date | null;
  agentSeenAt?: Date | null;
  lastMessageAt: Date;
  solvedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type SupportCounterRow = {
  id: string;
  key: string;
  value: number;
};

export type SupportTicketTagRow = {
  id: string;
  ticketId: string;
  tag: string;
};

export type SupportMessageRow = {
  id: string;
  ticketId: string;
  kind: MessageKind;
  authorType: AuthorType;
  userId?: string | null;
  authorEmail?: string | null;
  authorName?: string | null;
  body: string;
  data?: SupportEventData | null;
  mentions?: string[] | null;
  emailMessageId?: string | null;
  channel: TicketChannel;
  verified: boolean;
  createdAt: Date;
};

export type SupportCannedReplyRow = {
  id: string;
  title: string;
  body: string;
  userId?: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type SupportDeliveryRow = {
  id: string;
  messageId: string;
  ticketId: string;
  status: DeliveryStatus;
  scheduledFor: Date;
  claimedAt?: Date | null;
  attempts: number;
  /** Last error, or why the delivery was skipped. */
  detail?: string | null;
  /** The mailer's id for the send (`MailResult.id`). */
  providerId?: string | null;
  createdAt: Date;
};

export type SupportAttachmentRow = {
  id: string;
  ticketId: string;
  messageId?: string | null;
  userId?: string | null;
  internal: boolean;
  filename: string;
  contentType: string;
  size: number;
  storageKey: string;
  createdAt: Date;
};
