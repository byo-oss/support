// BYO_STUB: final owner N11b. Signature is final (contracts.md); body is neutral (rejects everything).
import type { SupportInboundSource } from "../options";

export type RawRelayOptions = {
  /** Shared secret the relay sends as `Authorization: Bearer <secret>`. */
  secret: string;
  /** Largest message accepted, in bytes; larger answers 413. @default 26214400 */
  maxBytes?: number;
};

/**
 * An inbound source for any relay that POSTs the raw message
 * (`Content-Type: message/rfc822`) with a bearer secret: Postmark, Mailgun,
 * Cloudflare Email Workers. Compares the secret in constant time (401 on
 * mismatch or absence) and reads at most `maxBytes` (413 past it).
 */
export function rawRelay(_options: RawRelayOptions): SupportInboundSource {
  return { receive: async () => ({ reject: 401 }) };
}
