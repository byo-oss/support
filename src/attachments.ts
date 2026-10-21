import { APIError } from "better-auth/api";
import { chunk, findAll, findManyIn, type SupportRuntime } from "./adapter";
import { SUPPORT_ERROR_CODES } from "./error-codes";
import {
  FORBIDDEN_TYPES,
  normalizeContentType,
  type ResolvedAttachmentOptions,
  SUPPORT_LIMITS,
  type SupportInboundPart,
} from "./options";
import type {
  SupportAttachmentRow,
  SupportMessageRow,
  SupportTicketRow,
} from "./schema";

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
  | "type_not_allowed"
  /** `storage.put` threw; the row was removed again. */
  | "storage_failed";

// ---------------------------------------------------------------------------
// Shared helpers (also used by routes/attachments.ts)
// ---------------------------------------------------------------------------

/**
 * A filename as stored: the last path part (`/` or `\`), trimmed, at most
 * 200 characters; `"attachment"` when nothing is left. The same rule names a
 * dropped inbound part in its `attachment_dropped` event.
 */
export function sanitizeFilename(name: string | null | undefined): string {
  const base = (name ?? "").split(/[\\/]/).pop()?.trim();
  return (base || "attachment").slice(0, SUPPORT_LIMITS.filename);
}

/**
 * Whether a content type may be stored: normalized, in `allowedTypes`, and
 * never HTML, SVG or XHTML (boot refuses those in `allowedTypes`; this is the
 * second guard).
 */
export function isAllowedType(
  attachments: ResolvedAttachmentOptions,
  contentType: string,
): boolean {
  const type = normalizeContentType(contentType);
  if (!type) return false;
  if ((FORBIDDEN_TYPES as readonly string[]).includes(type)) return false;
  return attachments.allowedTypes.includes(type);
}

/** `support/<organizationId or "_">/<attachmentId>`: keys carry the org, so one `deletePrefix` removes an org's blobs. */
export function attachmentKey(
  ticket: Pick<SupportTicketRow, "organizationId">,
  attachmentId: string,
): string {
  return `support/${ticket.organizationId ?? "_"}/${attachmentId}`;
}

/** The agent view of a row, built field by field so `storageKey` and `userId` never leak. */
export function toTicketAttachment(
  row: SupportAttachmentRow,
): TicketAttachment {
  return {
    id: row.id,
    ticketId: row.ticketId,
    messageId: row.messageId ?? null,
    filename: row.filename,
    contentType: row.contentType,
    size: row.size,
    internal: row.internal,
    createdAt: row.createdAt,
  };
}

/** The customer view of a row: the agent view without `internal`. */
export function toCustomerAttachment(
  row: SupportAttachmentRow,
): CustomerAttachment {
  return {
    id: row.id,
    ticketId: row.ticketId,
    messageId: row.messageId ?? null,
    filename: row.filename,
    contentType: row.contentType,
    size: row.size,
    createdAt: row.createdAt,
  };
}

/**
 * Writes one file: the `supportAttachment` row and its blob.
 *
 * - `generateId` returns a string (default ids, uuid): create the row with
 *   that id (`forceAllowId`) and its final `storageKey`, then `put`.
 * - It returns `false` (serial ids): create the row with `storageKey: ""`,
 *   `put` under the key built from the id the database gave it, then update
 *   `storageKey`.
 *
 * If `put` throws, the row is deleted and the error rethrown, so a failed
 * upload never leaves a row behind.
 */
export async function writeAttachment(
  rt: SupportRuntime,
  attachments: ResolvedAttachmentOptions,
  input: {
    ticket: SupportTicketRow;
    messageId: string | null;
    userId: string | null;
    internal: boolean;
    filename: string;
    contentType: string;
    body: Uint8Array;
  },
): Promise<SupportAttachmentRow> {
  const { ticket, body } = input;
  // every nullable field written explicitly, so `eq null` matches on every adapter
  const fields = {
    ticketId: ticket.id,
    messageId: input.messageId,
    userId: input.userId,
    internal: input.internal,
    filename: input.filename,
    contentType: input.contentType,
    size: body.byteLength,
    createdAt: new Date(),
  };
  const put = async (rowId: string, key: string) => {
    try {
      await attachments.storage.put({
        key,
        body,
        contentType: input.contentType,
      });
    } catch (error) {
      try {
        await rt.adapter.delete({
          model: "supportAttachment",
          where: [{ field: "id", value: rowId }],
        });
      } catch (cleanup) {
        rt.context.logger.error(
          "[@byo-oss/support] could not remove an attachment row after a failed put",
          cleanup,
        );
      }
      throw error;
    }
  };

  const id = rt.context.generateId({ model: "supportAttachment" });
  if (typeof id === "string") {
    const storageKey = attachmentKey(ticket, id);
    // `id` is allowed through by `forceAllowId`
    const row = await rt.adapter.create<
      Record<string, unknown>,
      SupportAttachmentRow
    >({
      model: "supportAttachment",
      data: { id, ...fields, storageKey },
      forceAllowId: true,
    });
    await put(row.id, row.storageKey);
    return row;
  }

  // serial ids: the key needs the id the database assigns
  const row = await rt.adapter.create<
    typeof fields & { storageKey: string },
    SupportAttachmentRow
  >({
    model: "supportAttachment",
    data: { ...fields, storageKey: "" },
  });
  const storageKey = attachmentKey(ticket, row.id);
  await put(row.id, storageKey);
  const updated = await rt.adapter.update<SupportAttachmentRow>({
    model: "supportAttachment",
    where: [{ field: "id", value: row.id }],
    update: { storageKey },
  });
  return updated ?? { ...row, storageKey };
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

const notUsable = () =>
  APIError.from("BAD_REQUEST", SUPPORT_ERROR_CODES.ATTACHMENT_NOT_USABLE);

/**
 * Checks `attachmentIds` before the message is inserted. Empty or undefined:
 * `[]` (no query). Ids given but no `attachments` option: 400
 * `STORAGE_NOT_CONFIGURED`. Otherwise every id must exist, belong to
 * `ticketId` (the resolved ticket, after `resolveMergedTicket`), be uploaded
 * by `uploaderId`, be unattached (`messageId` null), and match the audience
 * exactly: `attachment.internal === (kind === "note")` (internal uploads only
 * on notes, public uploads only on replies). Any failure: 400
 * `ATTACHMENT_NOT_USABLE`. Returns the rows to bind.
 */
export async function validateAttachments(
  rt: SupportRuntime,
  input: {
    ticketId: string;
    uploaderId: string;
    attachmentIds?: readonly string[] | undefined;
    kind: "reply" | "note";
  },
): Promise<SupportAttachmentRow[]> {
  if (!input.attachmentIds || input.attachmentIds.length === 0) return [];
  if (!rt.opts.attachments) {
    throw APIError.from(
      "BAD_REQUEST",
      SUPPORT_ERROR_CODES.STORAGE_NOT_CONFIGURED,
    );
  }
  const ids = [...new Set(input.attachmentIds)];
  const rows = await findManyIn<SupportAttachmentRow>(rt.adapter, {
    model: "supportAttachment",
    field: "id",
    values: ids,
  });
  if (rows.length !== ids.length) throw notUsable();
  const internal = input.kind === "note";
  for (const row of rows) {
    if (
      row.ticketId !== input.ticketId ||
      row.userId !== input.uploaderId ||
      row.messageId != null ||
      row.internal !== internal
    ) {
      throw notUsable();
    }
  }
  return rows;
}

/**
 * Binds validated attachments to the message just inserted: sets `messageId`
 * where `id in` the rows and `messageId` is still null. No query for an
 * empty list.
 */
export async function bindAttachments(
  rt: SupportRuntime,
  input: { attachments: readonly SupportAttachmentRow[]; messageId: string },
): Promise<void> {
  const ids = [...new Set(input.attachments.map((row) => row.id))];
  for (const part of chunk(ids)) {
    await rt.adapter.updateMany({
      model: "supportAttachment",
      where: [
        { field: "id", operator: "in", value: part },
        { field: "messageId", value: null },
      ],
      update: { messageId: input.messageId },
    });
  }
}

// oldest first, then by id
const byCreatedAt = (a: SupportAttachmentRow, b: SupportAttachmentRow) =>
  new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * A ticket's attached files (`messageId` set), oldest first. Agents get all
 * of them. Customers get only rows with `internal: false` whose bound message
 * has `kind: "reply"` (a second guard: nothing bound to a note or event ever
 * reaches a customer), without the `internal` field. Without `attachments`:
 * `[]` (the table doesn't exist).
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
  rt: SupportRuntime,
  ticketId: string,
  audience: AttachmentAudience,
): Promise<CustomerAttachment[] | TicketAttachment[]> {
  if (!rt.opts.attachments) return [];
  const rows = await findAll<SupportAttachmentRow>(rt.adapter, {
    model: "supportAttachment",
    where: [{ field: "ticketId", value: ticketId }],
    max: Number.MAX_SAFE_INTEGER,
  });
  // unattached uploads are filtered here: no `ne` on a nullable field
  const attached = rows.filter((row) => row.messageId != null);
  attached.sort(byCreatedAt);
  if (audience === "agent") return attached.map(toTicketAttachment);

  const candidates = attached.filter((row) => row.internal === false);
  const messages = await findManyIn<Pick<SupportMessageRow, "id" | "kind">>(
    rt.adapter,
    {
      model: "supportMessage",
      field: "id",
      values: candidates.map((row) => row.messageId as string),
      select: ["id", "kind"],
    },
  );
  const replies = new Set(
    messages.filter((m) => m.kind === "reply").map((m) => m.id),
  );
  return candidates
    .filter((row) => replies.has(row.messageId as string))
    .map(toCustomerAttachment);
}

/**
 * Deletes uploads still unattached `opts.uploadTtlMs` (24 h) after
 * `createdAt`: blob first, then row. Returns how many. Without `attachments`: 0.
 * Each row is read again as `{ id, messageId: null }` just before its blob is
 * deleted, and the row is deleted under the same guard, so an upload a reply
 * bound since the sweep listed it is kept with its blob. A blob that can't be
 * deleted is logged and its row kept, so the next sweep tries again and one
 * bad blob never fails the sweep.
 */
export async function pruneUploads(
  rt: SupportRuntime,
  now: Date,
): Promise<number> {
  const attachments = rt.opts.attachments;
  if (!attachments) return 0;
  const cutoff = new Date(now.getTime() - rt.opts.uploadTtlMs);
  // read first, then delete: paging with an offset while deleting skips rows
  const stale = await findAll<SupportAttachmentRow>(rt.adapter, {
    model: "supportAttachment",
    where: [
      { field: "messageId", value: null },
      { field: "createdAt", operator: "lt", value: cutoff },
    ],
    max: Number.MAX_SAFE_INTEGER,
  });
  let pruned = 0;
  for (const listed of stale) {
    // a reply may have bound it since the list was read: look again, and keep
    // it (with its blob) when it's attached now
    const unattached = [
      { field: "id", value: listed.id },
      { field: "messageId", value: null },
    ];
    const row = await rt.adapter.findOne<SupportAttachmentRow>({
      model: "supportAttachment",
      where: unattached,
    });
    if (!row) continue;
    if (row.storageKey) {
      try {
        await attachments.storage.delete(row.storageKey);
      } catch (error) {
        rt.context.logger.error(
          "[@byo-oss/support] could not delete an expired upload's blob",
          error,
        );
        continue;
      }
    }
    // the count isn't trusted: some drivers report 0 rows for a delete that worked
    await rt.adapter.deleteMany({
      model: "supportAttachment",
      where: unattached,
    });
    pruned++;
  }
  return pruned;
}

/**
 * Stores one inbound attachment part on an inbound message, under the same
 * type and size limits as uploads (`internal: false`, `userId` the sender's
 * account or null). Never throws for a part it refuses: returns why, and the
 * caller (`receiveEmail`) writes the `attachment_dropped` event. Without
 * `attachments`: `{ dropped: true, reason: "no_storage" }`. Row and blob
 * are written in the order `routes/attachments.ts` documents (id first);
 * a failed write leaves no row and reports `storage_failed`.
 */
export async function storeInboundPart(
  rt: SupportRuntime,
  input: {
    ticket: SupportTicketRow;
    messageId: string;
    userId: string | null;
    part: SupportInboundPart;
  },
): Promise<
  | { stored: SupportAttachmentRow }
  | { dropped: true; reason: InboundPartDropReason }
> {
  const attachments = rt.opts.attachments;
  if (!attachments) return { dropped: true, reason: "no_storage" };
  const { part } = input;
  if (part.content.byteLength > attachments.maxBytes) {
    return { dropped: true, reason: "too_large" };
  }
  if (!isAllowedType(attachments, part.contentType)) {
    return { dropped: true, reason: "type_not_allowed" };
  }
  try {
    const stored = await writeAttachment(rt, attachments, {
      ticket: input.ticket,
      messageId: input.messageId,
      userId: input.userId,
      internal: false,
      filename: sanitizeFilename(part.filename),
      contentType: normalizeContentType(part.contentType),
      body: part.content,
    });
    return { stored };
  } catch (error) {
    // never a half-stored part: `writeAttachment` removed the row already
    rt.context.logger.error(
      "[@byo-oss/support] could not store an inbound attachment",
      error,
    );
    return { dropped: true, reason: "storage_failed" };
  }
}
