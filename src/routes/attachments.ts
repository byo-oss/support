import {
  APIError,
  createAuthEndpoint,
  isAPIError,
  sessionMiddleware,
} from "better-auth/api";
import * as z from "zod";
import { checkSession, requireAgent, requireCustomer } from "../access";
import { endpointRuntime, type SupportRuntime } from "../adapter";
import {
  isAllowedType,
  sanitizeFilename,
  toCustomerAttachment,
  toTicketAttachment,
  writeAttachment,
} from "../attachments";
import type {
  AgentAttachmentResponse,
  CustomerAttachmentResponse,
} from "../client";
import { SUPPORT_ERROR_CODES } from "../error-codes";
import { readCapped } from "../inbound/raw-relay";
import { resolveMergedTicket } from "../merge";
import {
  normalizeContentType,
  type ResolvedAttachmentOptions,
  type ResolvedSupportOptions,
} from "../options";
import type {
  SupportAttachmentRow,
  SupportMessageRow,
  SupportTicketRow,
} from "../schema";

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const idSchema = z.string().min(1);
// a client may send a full path; it is cut to its last part and to 200
// characters when stored, so the raw value only needs a sane upper bound
const MAX_RAW_FILENAME = 1024;
const filenameSchema = z.string().min(1).max(MAX_RAW_FILENAME);

const uploadQuerySchema = z.object({
  ticketId: idSchema,
  filename: filenameSchema,
});

const agentUploadQuerySchema = uploadQuerySchema.extend({
  internal: z.enum(["true", "false"]).optional(),
});

const getQuerySchema = z.object({ id: idSchema });

/** Types a browser may render inline as themselves; everything else is served as `application/octet-stream`. */
const SERVED_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const storageNotConfigured = () =>
  APIError.from("BAD_REQUEST", SUPPORT_ERROR_CODES.STORAGE_NOT_CONFIGURED);
const tooLarge = () =>
  APIError.from("PAYLOAD_TOO_LARGE", SUPPORT_ERROR_CODES.ATTACHMENT_TOO_LARGE);
const typeNotAllowed = () =>
  APIError.from(
    "UNSUPPORTED_MEDIA_TYPE",
    SUPPORT_ERROR_CODES.ATTACHMENT_TYPE_NOT_ALLOWED,
  );
const attachmentNotFound = () =>
  APIError.from("NOT_FOUND", SUPPORT_ERROR_CODES.ATTACHMENT_NOT_FOUND);
const ticketNotFound = () =>
  APIError.from("NOT_FOUND", SUPPORT_ERROR_CODES.TICKET_NOT_FOUND);

/** `opts.attachments`, or 400 `STORAGE_NOT_CONFIGURED`. */
function requireStorage(
  opts: ResolvedSupportOptions,
): ResolvedAttachmentOptions {
  if (!opts.attachments) throw storageNotConfigured();
  return opts.attachments;
}

/** The ticket named by `id` followed through merges (D2), or null. */
async function loadResolvedTicket(
  rt: SupportRuntime,
  id: string,
): Promise<SupportTicketRow | null> {
  const ticket = await rt.adapter.findOne<SupportTicketRow>({
    model: "supportTicket",
    where: [{ field: "id", value: id }],
  });
  return ticket ? resolveMergedTicket(rt.adapter, ticket) : null;
}

/** A `Content-Length` that is a plain non-negative integer, or null. */
function contentLength(headers: Headers): number | null {
  const value = headers.get("content-length")?.trim();
  if (!value || !/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Reads an upload's raw body under the attachment rules: `Content-Length`
 * missing or over `maxBytes` → 413 `ATTACHMENT_TOO_LARGE`; type not allowed
 * → 415 `ATTACHMENT_TYPE_NOT_ALLOWED`; then the body is read while counting
 * bytes and abandoned as soon as it passes the declared length, so a lying
 * header can't store more than it claimed (and never more than `maxBytes`).
 */
async function readUpload(
  request: Request,
  attachments: ResolvedAttachmentOptions,
): Promise<{ body: Uint8Array; contentType: string }> {
  const declared = contentLength(request.headers);
  if (declared === null || declared > attachments.maxBytes) throw tooLarge();
  const contentType = normalizeContentType(
    request.headers.get("content-type") ?? "",
  );
  if (!isAllowedType(attachments, contentType)) throw typeNotAllowed();
  const body = await readCapped(request.body, declared);
  if (body === null) throw tooLarge();
  return { body, contentType };
}

/** RFC 8187 `filename*` value: UTF-8, percent-encoded. */
function encodeFilename(filename: string): string {
  return encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * The file as a download: the blob's bytes with headers that keep a browser
 * from rendering it in the app's origin. 404 `ATTACHMENT_NOT_FOUND` when the
 * blob is gone.
 */
async function serve(
  attachments: ResolvedAttachmentOptions,
  row: SupportAttachmentRow,
): Promise<Response> {
  const stored = row.storageKey
    ? await attachments.storage.get(row.storageKey)
    : null;
  if (!stored) throw attachmentNotFound();
  const type = normalizeContentType(row.contentType);
  return new Response(stored.body, {
    status: 200,
    headers: {
      "Content-Type": SERVED_TYPES.has(type)
        ? type
        : "application/octet-stream",
      "Content-Length": String(stored.size),
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeFilename(row.filename)}`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox",
      "Cache-Control": "private, no-store",
    },
  });
}

async function findAttachment(
  rt: SupportRuntime,
  id: string,
): Promise<SupportAttachmentRow | null> {
  return rt.adapter.findOne<SupportAttachmentRow>({
    model: "supportAttachment",
    where: [{ field: "id", value: id }],
  });
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/**
 * `uploadSupportAttachment`, `getSupportAttachment`,
 * `uploadSupportAttachmentAsAgent`, `getSupportAttachmentAsAgent`. Registered
 * always; without `attachments` they answer 400 `STORAGE_NOT_CONFIGURED`.
 * Uploads use `disableBody: true` and `requireRequest: true`, and resolve
 * `ticketId` through `resolveMergedTicket` first.
 *
 * Writing a file (uploads and `storeInboundPart`): when
 * `context.generateId({ model: "supportAttachment" })` returns a string,
 * create the row with that id (`forceAllowId: true`) and its final
 * `storageKey`, then `storage.put`; if the put throws, delete the row and
 * rethrow. When it returns `false` (serial ids), create the row with
 * `storageKey: ""`, put under the key built from the returned id, then update
 * `storageKey`; delete the row if the put throws.
 *
 * `getSupportAttachment` serves an attached file only if it is not internal,
 * its bound message has `kind: "reply"`, and the caller passes the read rule
 * on its ticket; an unattached file only to its uploader. Anything else: 404
 * `ATTACHMENT_NOT_FOUND`.
 */
export function attachmentEndpoints(opts: ResolvedSupportOptions) {
  return {
    /**
     * Uploads one file to a ticket the caller may reply on (requester or
     * teammate), as the raw request body with the file's type as
     * `Content-Type`. Returns the unattached attachment; pass its id in
     * `attachmentIds` on the next reply. Unattached uploads are pruned after
     * 24 h.
     */
    uploadSupportAttachment: createAuthEndpoint(
      "/support/upload",
      {
        method: "POST",
        query: uploadQuerySchema,
        disableBody: true,
        requireRequest: true,
        use: [sessionMiddleware],
      },
      async (ctx) => {
        const attachments = requireStorage(opts);
        const rt = endpointRuntime(ctx, opts);
        const { session, ticket } = await requireCustomer(
          ctx,
          opts,
          await loadResolvedTicket(rt, ctx.query.ticketId),
          "reply",
        );
        const { body, contentType } = await readUpload(
          ctx.request,
          attachments,
        );
        const row = await writeAttachment(rt, attachments, {
          ticket,
          messageId: null,
          userId: session.user.id,
          internal: false,
          filename: sanitizeFilename(ctx.query.filename),
          contentType,
          body,
        });
        return {
          attachment: toCustomerAttachment(row),
        } satisfies CustomerAttachmentResponse;
      },
    ),

    /**
     * Downloads a file. Attached: only a non-internal file bound to a reply,
     * on a ticket the caller can read. Unattached: only its uploader.
     * Anything else: 404 `ATTACHMENT_NOT_FOUND`.
     */
    getSupportAttachment: createAuthEndpoint(
      "/support/attachment",
      { method: "GET", query: getQuerySchema, use: [sessionMiddleware] },
      async (ctx) => {
        const attachments = requireStorage(opts);
        const session = await checkSession(ctx, opts, "customer");
        const rt = endpointRuntime(ctx, opts);
        const row = await findAttachment(rt, ctx.query.id);
        if (!row) throw attachmentNotFound();

        if (row.messageId == null) {
          if (!row.userId || row.userId !== session.user.id) {
            throw attachmentNotFound();
          }
          return serve(attachments, row);
        }

        if (row.internal) throw attachmentNotFound();
        const message = await rt.adapter.findOne<SupportMessageRow>({
          model: "supportMessage",
          where: [{ field: "id", value: row.messageId }],
        });
        if (message?.kind !== "reply") throw attachmentNotFound();
        const ticket = await rt.adapter.findOne<SupportTicketRow>({
          model: "supportTicket",
          where: [{ field: "id", value: row.ticketId }],
        });
        try {
          await requireCustomer(ctx, opts, ticket, "read");
        } catch (error) {
          // a ticket the caller can't see hides the file too (no existence leak)
          if (isAPIError(error) && error.statusCode === 404) {
            throw attachmentNotFound();
          }
          throw error;
        }
        return serve(attachments, row);
      },
    ),

    /**
     * Uploads one file to any ticket as an agent (`support:reply`).
     * `internal=true` marks it for a note: it can then only be attached to a
     * note and is never readable by customers.
     */
    uploadSupportAttachmentAsAgent: createAuthEndpoint(
      "/support/agent/upload",
      {
        method: "POST",
        query: agentUploadQuerySchema,
        disableBody: true,
        requireRequest: true,
        use: [sessionMiddleware],
      },
      async (ctx) => {
        const attachments = requireStorage(opts);
        const session = await requireAgent(ctx, opts, "reply");
        const rt = endpointRuntime(ctx, opts);
        const ticket = await loadResolvedTicket(rt, ctx.query.ticketId);
        if (!ticket) throw ticketNotFound();
        const { body, contentType } = await readUpload(
          ctx.request,
          attachments,
        );
        const row = await writeAttachment(rt, attachments, {
          ticket,
          messageId: null,
          userId: session.user.id,
          internal: ctx.query.internal === "true",
          filename: sanitizeFilename(ctx.query.filename),
          contentType,
          body,
        });
        return {
          attachment: toTicketAttachment(row),
        } satisfies AgentAttachmentResponse;
      },
    ),

    /** Downloads any file, attached or not, as an agent (`support:read`). */
    getSupportAttachmentAsAgent: createAuthEndpoint(
      "/support/agent/attachment",
      { method: "GET", query: getQuerySchema, use: [sessionMiddleware] },
      async (ctx) => {
        const attachments = requireStorage(opts);
        await requireAgent(ctx, opts, "read");
        const row = await findAttachment(
          endpointRuntime(ctx, opts),
          ctx.query.id,
        );
        if (!row) throw attachmentNotFound();
        return serve(attachments, row);
      },
    ),
  };
}
