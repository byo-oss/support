// BYO_STUB: final owner N11b. Signature is final (contracts.md); body is neutral (rejects everything).
// Loads @aws-sdk/client-s3 with a dynamic import() only when no client is given.
import type { SupportInboundSource } from "./options";

export { type WrapsMailerOptions, wrapsMailer } from "@byo-oss/mailer/wraps";

/** The part of an S3 client `wrapsInbound` uses, so tests pass a fake. */
export type WrapsInboundS3Client = {
  send(command: unknown): Promise<unknown>;
};

export type WrapsInboundOptions = {
  /** The `X-Wraps-Inbound-Key` secret Wraps sends with each event. */
  key: string;
  /** Bucket Wraps stores raw mail in. */
  bucket: string;
  region: string;
  /** An S3 client; one is created from `region` when omitted. */
  client?: WrapsInboundS3Client;
  /** Largest message accepted, in bytes. @default 26214400 */
  maxBytes?: number;
};

/**
 * An inbound source for Wraps (SES → S3 → EventBridge `email.received`):
 * checks `X-Wraps-Inbound-Key` in constant time (401), reads `rawS3Key` from
 * the event and fetches the object. `NoSuchKey` → 404 (no retry); any other
 * S3 error → 502 (retry); over `maxBytes` → 413.
 */
export function wrapsInbound(
  _options: WrapsInboundOptions,
): SupportInboundSource {
  return { receive: async () => ({ reject: 401 }) };
}
