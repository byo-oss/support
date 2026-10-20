// BYO_STUB: final owner N10b. Signatures and output types are final (contracts.md); body is neutral.
import type { AuthWithContext } from "./adapter";
import type {
  SupportAttachmentRow,
  SupportCannedReplyRow,
  SupportDeliveryRow,
  SupportMessageRow,
  SupportTicketRow,
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

export type ExportedTicket = Serialized<SupportTicketRow> & {
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

/**
 * Exports support data a page at a time as plain JSON in the documented
 * schema (SPEC §9.3), server-only. Tickets with tags, messages (with their
 * deliveries) and attachment metadata; every row with a user id carries that
 * user's current email. `supportCounter` is left out (operational state).
 * Throws `[@byo-oss/support] exportSupportData: …` on a bad limit, empty
 * organizationId or malformed cursor.
 */
export async function exportSupportData(
  _auth: AuthWithContext,
  _options: ExportSupportDataOptions = {},
): Promise<SupportExportPage> {
  return { tickets: [], cannedReplies: [], cursor: null };
}
