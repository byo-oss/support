import type { SupportInboundSource } from "../options";

export type RawRelayOptions = {
  /** Shared secret the relay sends as `Authorization: Bearer <secret>`. No whitespace. */
  secret: string;
  /** Largest message accepted, in bytes; larger answers 413. @default 26214400 */
  maxBytes?: number;
};

/** The default cap for one raw message, the same as `inbound.maxBytes`. */
export const DEFAULT_INBOUND_MAX_BYTES = 26_214_400;

/** SHA-256 of a string's UTF-8 bytes, through Web Crypto (any runtime). */
async function sha256(value: string): Promise<Uint8Array> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return new Uint8Array(digest);
}

/**
 * Compares two byte arrays without stopping at the first difference: the
 * time taken depends only on their length.
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/**
 * Compares a secret a caller sent with the configured one in constant time.
 * Both sides are hashed with SHA-256 (Web Crypto) first, so the compare always
 * runs over two 32-byte digests and the time taken doesn't leak the secret's
 * length either. An absent or empty value never matches.
 */
export async function secretsMatch(
  given: string | null | undefined,
  expected: string,
): Promise<boolean> {
  if (!given || !expected) return false;
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  return constantTimeEqual(a, b);
}

/** The declared `Content-Length`, or null when it's absent or not a number. */
export function declaredLength(headers: Headers): number | null {
  const value = headers.get("content-length");
  if (value === null || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Joins chunks into one plain `Uint8Array` (never a Buffer). */
export function concatBytes(chunks: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Reads a stream into one `Uint8Array`, cancelling it as soon as more than
 * `maxBytes` arrive. Returns null past the cap. Throws when the stream errors.
 */
export async function readCapped(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array | null> {
  if (!stream) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return concatBytes(chunks, size);
}

function bearer(headers: Headers): string | null {
  const match = /^bearer\s+(\S+)\s*$/i.exec(
    headers.get("authorization")?.trim() ?? "",
  );
  return match?.[1] ?? null;
}

/**
 * An inbound source for any relay that POSTs the raw message
 * (`Content-Type: message/rfc822`) with a bearer secret: Postmark, Mailgun,
 * Cloudflare Email Workers. Compares the secret in constant time (401 on
 * mismatch or absence) and reads at most `maxBytes` (413 past it).
 *
 * An empty body answers 400. A body stream that fails while it's read throws,
 * so the endpoint answers 502 and the relay retries. Throws at setup when
 * `secret` is empty or contains whitespace.
 *
 * ```ts
 * inbound: { source: rawRelay({ secret: process.env.SUPPORT_INBOUND_SECRET! }) }
 * ```
 */
export function rawRelay(options: RawRelayOptions): SupportInboundSource {
  const { secret } = options;
  const maxBytes = options.maxBytes ?? DEFAULT_INBOUND_MAX_BYTES;
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error("[@byo-oss/support] rawRelay needs a non-empty secret");
  }
  // the bearer token is read as one run of non-space characters, so a secret
  // with whitespace in it (a trailing newline from an env file) never matches
  if (/\s/.test(secret)) {
    throw new Error(
      "[@byo-oss/support] rawRelay secret must not contain whitespace",
    );
  }
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new Error(
      "[@byo-oss/support] rawRelay maxBytes must be an integer of at least 1",
    );
  }
  return {
    async receive(request) {
      if (!(await secretsMatch(bearer(request.headers), secret))) {
        return { reject: 401 };
      }
      const declared = declaredLength(request.headers);
      if (declared !== null && declared > maxBytes) return { reject: 413 };
      const raw = await readCapped(request.body, maxBytes);
      if (raw === null) return { reject: 413 };
      if (raw.byteLength === 0) return { reject: 400 };
      return { raw };
    },
  };
}
