// The DKIM hardening (one From, From signed, no `l=`, a signature cap and a
// deadline) is adapted from better-helpdesk `src/inbound/verify.ts`
// (https://github.com/better-helpdesk/better-helpdesk), MIT License,
// Copyright (c) 2026 devguard AG. See NOTICE.
//
// Loads mailauth with a dynamic import() only, so the root entry stays light.

/** A DNS TXT resolver in mailauth's shape, injectable so tests stub DNS. */
export type DkimResolver = (
  name: string,
  rrtype: string,
) => Promise<string[] | string[][]>;

// Real mail carries one or two; each one is a DNS lookup and a body hash.
const MAX_SIGNATURES = 5;
const LOOKUP_TIMEOUT_MS = 5_000;
const DEADLINE_MS = 15_000;

/** The signature must cover From, or From could be swapped under it. */
function signsFrom(keys: string | undefined): boolean {
  return (keys ?? "")
    .split(":")
    .some((key) => key.trim().toLowerCase() === "from");
}

/** DKIM-Signature fields in the header block (the first 128 KiB is plenty). */
function signatureCount(raw: Uint8Array): number {
  const head = new TextDecoder("latin1").decode(raw.subarray(0, 128 * 1024));
  const end = head.search(/\r?\n\r?\n/);
  return (
    (end === -1 ? head : head.slice(0, end)).match(/^dkim-signature[ \t]*:/gim)
      ?.length ?? 0
  );
}

/** System DNS with a lookup timeout (Node's `dns`, loaded on first use). */
async function systemResolver(): Promise<DkimResolver> {
  const { Resolver } = await import("node:dns/promises");
  const dns = new Resolver({ timeout: LOOKUP_TIMEOUT_MS, tries: 2 });
  return (name, rrtype) =>
    dns.resolve(name, rrtype) as unknown as Promise<string[] | string[][]>;
}

/** The promise's value, or `fallback` once `ms` has passed (the work itself isn't cancelled). */
async function within<T, F>(
  promise: Promise<T>,
  ms: number,
  fallback: F,
): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<F>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * True when the raw message carries at least one passing DKIM signature whose
 * `d=` is aligned (relaxed: same organizational domain) with `fromDomain`,
 * computed by `mailauth` on the raw bytes, with or without a DMARC record.
 * Ignores any `Authentication-Results` already in the message and never uses
 * SPF. Any error: false.
 *
 * Also false when the message has more than one From address (a second From
 * could let one domain's signature vouch for another), when the signature
 * doesn't cover From, when it has an `l=` body limit (the rest of the body
 * could be appended to), or with more than 5 signatures.
 */
export async function verifyAlignedDkim(
  raw: Uint8Array,
  fromDomain: string,
  options: { resolver?: DkimResolver } = {},
): Promise<boolean> {
  try {
    const domain = fromDomain.trim().toLowerCase();
    const signatures = signatureCount(raw);
    if (!domain || signatures === 0 || signatures > MAX_SIGNATURES) {
      return false;
    }
    const { dkimVerify } = await import("mailauth");
    const resolver = options.resolver ?? (await systemResolver());
    const result = await within(
      dkimVerify(Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength), {
        resolver,
      }),
      DEADLINE_MS,
      null,
    );
    if (!result) return false;
    // alignment is computed against the From header mailauth reads; it must be
    // the single address whose domain the caller asked about
    const from = result.headerFrom;
    if (from.length !== 1 || result.fromFields !== 1) return false;
    const fromAddress = (from[0] ?? "").toLowerCase();
    if (fromAddress.slice(fromAddress.lastIndexOf("@") + 1) !== domain) {
      return false;
    }
    return result.results.some(
      (signature) =>
        signature.status.result === "pass" &&
        Boolean(signature.status.aligned) &&
        signsFrom(signature.signingHeaders?.keys) &&
        !signature.canonBodyLengthLimited,
    );
  } catch {
    return false;
  }
}
