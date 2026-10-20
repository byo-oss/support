// BYO_STUB: final owner N13. Signature is final (contracts.md); returns no endpoints yet.
import type { ResolvedSupportOptions } from "../options";

/**
 * `uploadSupportAttachment`, `getSupportAttachment`,
 * `uploadSupportAttachmentAsAgent`, `getSupportAttachmentAsAgent`. Registered
 * always; without `attachments` they answer 400 `STORAGE_NOT_CONFIGURED`.
 */
export function attachmentEndpoints(_opts: ResolvedSupportOptions) {
  return {};
}
