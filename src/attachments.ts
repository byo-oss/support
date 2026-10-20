// BYO_STUB: final owner N13. Signatures and output types are final (contracts.md); bodies are neutral.
import { APIError } from "better-auth/api";
import type { SupportRuntime } from "./adapter";
import { SUPPORT_ERROR_CODES } from "./error-codes";
import type { SupportInboundPart } from "./options";
import type { SupportAttachmentRow, SupportTicketRow } from "./schema";

/** Who is listing a ticket's attachments. */
export type AttachmentAudience = "customer" | "agent";

/** Attachment metadata as agents see it (no `storageKey`, no uploader id). */
export type TicketAttachment = {
  id: string;
  ticketId: string;
  messageId: string | null;
  filename: string;
  contentType: string;
  size: number;
  internal: boolean;
  createdAt: Date;
};

/** Attachment metadata as customers see it. */
export type CustomerAttachment = Omit<TicketAttachment, "internal">;

/** Why `storeInboundPart` dropped a part. */
export type InboundPartDropReason =
  | "no_storage"
  | "too_large"
  | "type_not_allowed";

/**
 * Checks `attachmentIds` before the message is inserted. Empty or undefined:
 * `[]` (no query). Ids given but no `attachments` option: 400
 * `STORAGE_NOT_CONFIGURED`. Otherwise every id must exist, belong to
 * `ticketId`, be uploaded by `uploaderId`, be unattached (`messageId` null),
 * and suit `kind` (an `internal` upload only on a `note`); any failure: 400
 * `ATTACHMENT_NOT_USABLE`. Returns the rows to bind.
 */
export async function validateAttachments(
  _rt: SupportRuntime,
  input: {
    ticketId: string;
    uploaderId: string;
    attachmentIds?: readonly string[] | undefined;
    kind: "reply" | "note";
  },
): Promise<SupportAttachmentRow[]> {
  if (!input.attachmentIds || input.attachmentIds.length === 0) return [];
  throw APIError.from(
    "BAD_REQUEST",
    SUPPORT_ERROR_CODES.STORAGE_NOT_CONFIGURED,
  );
}

/**
 * Binds validated attachments to the message just inserted: sets `messageId`
 * where `id in` the rows and `messageId` is still null. No query for an
 * empty list.
 */
export async function bindAttachments(
  _rt: SupportRuntime,
  _input: { attachments: readonly SupportAttachmentRow[]; messageId: string },
): Promise<void> {}

/**
 * A ticket's attached files (`messageId` set), oldest first. Customers get
 * no `internal` ones and no `internal` field. Without `attachments`: `[]`
 * (the table doesn't exist).
 */
export async function listTicketAttachments(
  rt: SupportRuntime,
  ticketId: string,
  audience: "customer",
): Promise<CustomerAttachment[]>;
export async function listTicketAttachments(
  rt: SupportRuntime,
  ticketId: string,
  audience: "agent",
): Promise<TicketAttachment[]>;
export async function listTicketAttachments(
  _rt: SupportRuntime,
  _ticketId: string,
  _audience: AttachmentAudience,
): Promise<CustomerAttachment[] | TicketAttachment[]> {
  return [];
}

/**
 * Deletes uploads still unattached `opts.uploadTtlMs` (24 h) after
 * `createdAt`: blob first, then row. Returns how many. Without `attachments`: 0.
 */
export async function pruneUploads(
  _rt: SupportRuntime,
  _now: Date,
): Promise<number> {
  return 0;
}

/**
 * Stores one inbound attachment part on an inbound message, under the same
 * type and size limits as uploads (`internal: false`, `userId` the sender's
 * account or null). Never throws for a part it refuses: returns why, and the
 * caller (`receiveEmail`) writes the `attachment_dropped` event. Without
 * `attachments`: `{ dropped: true, reason: "no_storage" }`.
 */
export async function storeInboundPart(
  _rt: SupportRuntime,
  _input: {
    ticket: SupportTicketRow;
    messageId: string;
    userId: string | null;
    part: SupportInboundPart;
  },
): Promise<
  | { stored: SupportAttachmentRow }
  | { dropped: true; reason: InboundPartDropReason }
> {
  return { dropped: true, reason: "no_storage" };
}
