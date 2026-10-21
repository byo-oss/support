// Quoted-reply stripping adapted from better-helpdesk `src/inbound/parse.ts`
// (https://github.com/better-helpdesk/better-helpdesk), MIT License,
// Copyright (c) 2026 devguard AG. See NOTICE.
//
// Loads the MIME parser with a dynamic import() only, so the root entry stays light.
import type { SupportInboundPart } from "../options";

export type ParsedAddress = { address: string; name: string | null };

/** What support needs from a raw RFC 822 message. Addresses are lowercased. */
export type ParsedMessage = {
  /** `Message-ID` with angle brackets, as sent; null when missing. */
  messageId: string | null;
  from: ParsedAddress | null;
  /** `To`, `Cc` and `Delivered-To`/`X-Original-To` recipients, lowercased, deduped. */
  recipients: string[];
  subject: string;
  /** The text body with the quoted reply stripped (HTML converted to text when there is no text part). */
  text: string;
  inReplyTo: string | null;
  references: string[];
  /** `Return-Path` address; `""` for the null path `<>`; null when absent. */
  returnPath: string | null;
  /** Header names lowercased; repeated headers joined with ", ". */
  headers: Record<string, string>;
  attachments: SupportInboundPart[];
};

const QUOTE_START = [
  /^on .+ wrote:?\s*$/i,
  /^am .+ schrieb\b.*:\s*$/i,
  /^-{2,}\s*(original message|ursprüngliche nachricht)/i,
  /^_{5,}$/,
  /^(from|von):\s.+/i,
];

/**
 * Drops the quoted history under a reply, keeping what the sender wrote: cuts
 * at the first quote header ("On … wrote:", "-----Original Message-----", an
 * Outlook "From:" block) and trims trailing `>` lines. Returns the whole text
 * when stripping would leave nothing.
 */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  // a quote header is one short line; the patterns backtrack on long ones
  const cut = lines.findIndex(
    (line) =>
      line.length <= 500 && QUOTE_START.some((re) => re.test(line.trim())),
  );
  const kept = cut === -1 ? lines : lines.slice(0, cut);
  while (
    kept.length > 0 &&
    (kept.at(-1)?.trim() === "" || kept.at(-1)?.startsWith(">"))
  ) {
    kept.pop();
  }
  const result = kept.join("\n").trim();
  return result || text.trim();
}

/** `<id>` tokens of a Message-ID list header, in order. */
function messageIds(value: string | undefined): string[] {
  if (!value) return [];
  const bracketed = value.match(/<[^<>\s]+>/g);
  if (bracketed) return bracketed;
  return value.split(/\s+/).filter(Boolean);
}

type MailboxLike = { address?: string; name?: string; group?: MailboxLike[] };

/** Every mailbox address of a parsed address list, groups flattened, lowercased. */
function addressesOf(list: readonly MailboxLike[] | undefined): string[] {
  const out: string[] = [];
  for (const entry of list ?? []) {
    if (entry.group) out.push(...addressesOf(entry.group));
    else if (entry.address) out.push(entry.address.trim().toLowerCase());
  }
  return out;
}

/**
 * Parses a raw message (`postal-mime`, loaded by dynamic `import()`). Throws
 * on unparseable input.
 */
export async function parseMessage(raw: Uint8Array): Promise<ParsedMessage> {
  const { default: PostalMime, addressParser } = await import("postal-mime");
  const email = await PostalMime.parse(raw, {
    attachmentEncoding: "arraybuffer",
  });

  const headers: Record<string, string> = {};
  const all = (key: string) =>
    email.headers.filter((header) => header.key === key);
  for (const header of email.headers) {
    const key = header.key.toLowerCase();
    headers[key] =
      headers[key] === undefined
        ? header.value
        : `${headers[key]}, ${header.value}`;
  }

  const sender = addressesOf(
    email.from ? [email.from as MailboxLike] : undefined,
  )[0];
  const fromEntry = email.from as MailboxLike | undefined;
  const fromName = (fromEntry?.group?.[0]?.name ?? fromEntry?.name)?.trim();

  const recipients = new Set<string>([
    ...addressesOf(email.to),
    ...addressesOf(email.cc),
  ]);
  for (const header of [...all("delivered-to"), ...all("x-original-to")]) {
    for (const address of addressesOf(addressParser(header.value))) {
      recipients.add(address);
    }
  }

  // postal-mime leaves out the null path `<>`, which is what marks a bounce
  let returnPath: string | null = null;
  const returnPathHeader = all("return-path")[0];
  if (returnPathHeader) {
    const value = returnPathHeader.value.trim();
    returnPath =
      value === "" || /^<\s*>$/.test(value)
        ? ""
        : (addressesOf(addressParser(value))[0] ?? "");
  }

  const text =
    email.text ??
    (email.html ? email.html.replace(/<[^>]*>/g, " ") : undefined) ??
    "";

  return {
    messageId: email.messageId?.trim() || null,
    from: sender ? { address: sender, name: fromName || null } : null,
    recipients: [...recipients],
    subject: (email.subject ?? "").trim(),
    text: stripQuoted(text),
    inReplyTo: messageIds(email.inReplyTo)[0] ?? null,
    references: messageIds(email.references),
    returnPath,
    headers,
    attachments: email.attachments.map((attachment) => ({
      filename: attachment.filename,
      contentType: attachment.mimeType,
      content:
        typeof attachment.content === "string"
          ? new TextEncoder().encode(attachment.content)
          : new Uint8Array(attachment.content),
    })),
  };
}
