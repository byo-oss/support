// BYO_STUB: final owner N13. Signature is final (contracts.md); returns no endpoints yet.
import type { ResolvedSupportOptions } from "../options";

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
export function attachmentEndpoints(_opts: ResolvedSupportOptions) {
  return {};
}
