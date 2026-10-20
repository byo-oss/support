// RFC 4648 base32 alphabet, lowercased so a token survives mail systems that
// lowercase the local part of an address
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** Length of a reply token: 128 bits in base32 is 26 characters. */
export const REPLY_TOKEN_LENGTH = 26;

const TOKEN_PATTERN = /^[a-z2-7]{26}$/;

/**
 * A new reply token: 128 random bits from `crypto.getRandomValues`, encoded
 * as 26 lowercase base32 characters. It goes into the Reply-To address
 * `support+<token>@<replyDomain>` and is never shown to customers.
 */
export function createReplyToken(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(buffer >> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

/**
 * Whether `value` has the shape of a reply token. Pass it already lowercased:
 * inbound matching lowercases the recipient's local part first.
 */
export function isReplyToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}
