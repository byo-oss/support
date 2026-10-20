// BYO_STUB: final owner N11a. Signature is final (contracts.md); body is neutral (never verified).
// Loads mailauth with a dynamic import() only, so the root entry stays light.

/** A DNS TXT resolver in mailauth's shape, injectable so tests stub DNS. */
export type DkimResolver = (
  name: string,
  rrtype: string,
) => Promise<string[] | string[][]>;

/**
 * True when the raw message carries at least one passing DKIM signature whose
 * `d=` is aligned (relaxed: same organizational domain) with `fromDomain`,
 * computed by `mailauth` on the raw bytes, with or without a DMARC record.
 * Ignores any `Authentication-Results` already in the message and never uses
 * SPF. Any error: false.
 */
export async function verifyAlignedDkim(
  _raw: Uint8Array,
  _fromDomain: string,
  _options: { resolver?: DkimResolver } = {},
): Promise<boolean> {
  return false;
}
