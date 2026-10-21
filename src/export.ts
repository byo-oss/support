import type { Where } from "better-auth";
import {
  type AuthWithContext,
  authRuntime,
  findAll,
  findManyIn,
  findUsersByIds,
} from "./adapter";
import type {
  SupportAttachmentRow,
  SupportCannedReplyRow,
  SupportDeliveryRow,
  SupportMessageRow,
  SupportTicketRow,
  SupportTicketTagRow,
} from "./schema";

/** A row with its dates as ISO strings. */
export type Serialized<T> = {
  [K in keyof T]: T[K] extends Date
    ? string
    : T[K] extends Date | null | undefined
      ? string | Exclude<T[K], Date>
      : T[K];
};

export type ExportedDelivery = Serialized<
  Omit<SupportDeliveryRow, "messageId" | "ticketId">
>;

export type ExportedAttachment = Serialized<SupportAttachmentRow> & {
  /** The uploader's current email. */
  userEmail: string | null;
};

export type ExportedMessage = Serialized<SupportMessageRow> & {
  /** The author's current email (account holders). */
  userEmail: string | null;
  /** Outbound deliveries of this message (only with a mailer). */
  deliveries: ExportedDelivery[];
};

/**
 * A ticket as exported. `replyToken` is left out: it lets mail be posted into
 * the ticket, and exports go to other tools.
 */
export type ExportedTicket = Omit<
  Serialized<SupportTicketRow>,
  "replyToken"
> & {
  /** The requester's current email (account holders). */
  userEmail: string | null;
  /** The assignee's current email. */
  assigneeEmail: string | null;
  tags: string[];
  /** Every message, oldest first, notes and events included. */
  messages: ExportedMessage[];
  /** Attachment metadata; `storageKey` locates the blob. Empty without `attachments`. */
  attachments: ExportedAttachment[];
};

export type ExportedCannedReply = Serialized<SupportCannedReplyRow> & {
  /** The author's current email. */
  userEmail: string | null;
};

export type ExportSupportDataOptions = {
  /** Only this organization's tickets (and no canned replies). Omit for everything. */
  organizationId?: string;
  /** `cursor` from the previous page. Omit for the first page. */
  cursor?: string | null;
  /** Tickets per page, 1 to 500. @default 100 */
  limit?: number;
};

export type SupportExportPage = {
  tickets: ExportedTicket[];
  /** Every canned reply on the first page of an export without `organizationId`; otherwise empty. */
  cannedReplies: ExportedCannedReply[];
  /** Pass to the next call; null when done. */
  cursor: string | null;
};

const EXPORT_LIMIT_DEFAULT = 100;
const EXPORT_LIMIT_MAX = 500;

// the cursor is the last ticket number exported, as a decimal string
const NUMBER_CURSOR = /^(0|[1-9]\d{0,14})$/;

const serialize = <T extends object>(row: T): Serialized<T> =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value instanceof Date ? value.toISOString() : value,
    ]),
  ) as Serialized<T>;

const timeOf = (value: Date | string) => new Date(value).getTime();

/** Groups rows by a key, keeping their order. */
function groupBy<T>(rows: readonly T[], key: (row: T) => string) {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const group = groups.get(k);
    if (group) group.push(row);
    else groups.set(k, [row]);
  }
  return groups;
}

/**
 * Exports support data a page at a time as plain JSON in the documented
 * schema (SPEC §9.3), server-only. Tickets with tags, messages (with their
 * deliveries) and attachment metadata; every row with a user id carries that
 * user's current email. `supportCounter` is left out (operational state).
 * Throws `[@byo-oss/support] exportSupportData: …` on a bad limit, empty
 * organizationId or malformed cursor.
 *
 * Tickets come in `number` order and the cursor is the last number exported,
 * so a ticket deleted mid-export never makes another one skip, and tickets
 * created mid-export (higher numbers) come on later pages. Deliveries exist
 * only with a `mailer`, attachments only with `attachments`; otherwise those
 * lists are empty. `replyToken` is never exported: it lets mail be posted
 * into a ticket. Inside a
 * better-auth transaction (`runWithTransaction`) it reads in that
 * transaction.
 */
export async function exportSupportData(
  auth: AuthWithContext,
  options: ExportSupportDataOptions = {},
): Promise<SupportExportPage> {
  const fail = (message: string) =>
    new Error(`[@byo-oss/support] exportSupportData: ${message}`);
  const limit = options.limit ?? EXPORT_LIMIT_DEFAULT;
  if (!Number.isInteger(limit) || limit < 1 || limit > EXPORT_LIMIT_MAX) {
    throw fail(`limit must be an integer from 1 to ${EXPORT_LIMIT_MAX}`);
  }
  const where: Where[] = [];
  // an empty organizationId must not fall through to "every organization"
  if (options.organizationId !== undefined) {
    if (!options.organizationId) throw fail("organizationId is empty");
    where.push({ field: "organizationId", value: options.organizationId });
  }
  // a keyset on number: unique, increasing, and compared as a number on
  // every adapter (never `id > cursor`, SPEC §2.7)
  let after: number | null = null;
  if (options.cursor) {
    if (!NUMBER_CURSOR.test(options.cursor)) {
      throw fail(`invalid cursor: ${options.cursor}`);
    }
    after = Number(options.cursor);
    where.push({ field: "number", operator: "gt", value: after });
  }

  const rt = await authRuntime(auth, "exportSupportData");
  const { adapter, opts } = rt;

  // one extra row says whether another page follows
  const page = await adapter.findMany<SupportTicketRow>({
    model: "supportTicket",
    where,
    limit: limit + 1,
    sortBy: { field: "number", direction: "asc" },
  });
  const tickets = page.slice(0, limit);
  const last = tickets.at(-1);
  const ticketIds = tickets.map((ticket) => ticket.id);
  const byTicket = { field: "ticketId", values: ticketIds } as const;

  const [tags, messages, deliveries, attachments, cannedReplies] =
    await Promise.all([
      findManyIn<SupportTicketTagRow>(adapter, {
        model: "supportTicketTag",
        ...byTicket,
      }),
      findManyIn<SupportMessageRow>(adapter, {
        model: "supportMessage",
        ...byTicket,
      }),
      // the table exists only with a mailer
      opts.mailer
        ? findManyIn<SupportDeliveryRow>(adapter, {
            model: "supportDelivery",
            ...byTicket,
          })
        : Promise.resolve([]),
      // and this one only with attachments
      opts.attachments
        ? findManyIn<SupportAttachmentRow>(adapter, {
            model: "supportAttachment",
            ...byTicket,
          })
        : Promise.resolve([]),
      // canned replies belong to no organization: whole exports only, once
      options.organizationId === undefined && after === null
        ? findAll<SupportCannedReplyRow>(adapter, {
            model: "supportCannedReply",
            where: [],
            max: Number.POSITIVE_INFINITY,
          })
        : Promise.resolve([]),
    ]);

  const users = await findUsersByIds(adapter, [
    ...tickets.flatMap((ticket) => [ticket.userId, ticket.assigneeId]),
    ...messages.map((message) => message.userId),
    ...attachments.map((attachment) => attachment.userId),
    ...cannedReplies.map((reply) => reply.userId),
  ]);
  const emailOf = (userId: string | null | undefined) =>
    (userId && users.get(userId)?.email) || null;

  const tagsOf = groupBy(tags, (tag) => tag.ticketId);
  const deliveriesOf = groupBy(deliveries, (delivery) => delivery.messageId);
  const attachmentsOf = groupBy(attachments, (a) => a.ticketId);
  const messagesOf = groupBy(
    [...messages].sort(
      (a, b) =>
        timeOf(a.createdAt) - timeOf(b.createdAt) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    ),
    (message) => message.ticketId,
  );

  return {
    tickets: tickets.map(({ replyToken: _token, ...ticket }) => ({
      ...serialize(ticket),
      userEmail: emailOf(ticket.userId),
      assigneeEmail: emailOf(ticket.assigneeId),
      tags: (tagsOf.get(ticket.id) ?? []).map((tag) => tag.tag).sort(),
      messages: (messagesOf.get(ticket.id) ?? []).map((message) => ({
        ...serialize(message),
        userEmail: emailOf(message.userId),
        deliveries: (deliveriesOf.get(message.id) ?? []).map(
          ({ messageId: _m, ticketId: _t, ...delivery }) => serialize(delivery),
        ),
      })),
      attachments: (attachmentsOf.get(ticket.id) ?? []).map((attachment) => ({
        ...serialize(attachment),
        userEmail: emailOf(attachment.userId),
      })),
    })),
    cannedReplies: cannedReplies.map((reply) => ({
      ...serialize(reply),
      userEmail: emailOf(reply.userId),
    })),
    cursor: page.length > limit && last ? String(last.number) : null,
  };
}
