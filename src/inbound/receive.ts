import type { Where } from "better-auth";
import {
  findManyIn,
  findMember,
  findUserByEmail,
  findUserById,
  lowerEmail,
  type SupportRuntime,
  type UserSummary,
} from "../adapter";
import { storeInboundPart } from "../attachments";
import { resolveMergedTicket } from "../merge";
import {
  type ResolvedEmailOptions,
  SUPPORT_LIMITS,
  type SupportInboundPart,
} from "../options";
import type {
  SupportEventData,
  SupportMessageRow,
  SupportTicketRow,
} from "../schema";
import { addMessage, createTicket } from "../tickets";
import { isReplyToken } from "../token";
import { type ParsedMessage, parseMessage } from "./parse";
import { type DkimResolver, verifyAlignedDkim } from "./verify";

export type InboundDropReason =
  | "too_large"
  | "unparseable"
  | "virus"
  | "no_sender"
  | "loop"
  | "auto_reply"
  | "bounce"
  | "duplicate"
  | "sender_cap"
  | "unverified_cap"
  | "no_new_tickets";

/** What `receiveEmail` did. The endpoint answers 202 for every outcome. */
export type InboundResult =
  | { status: "created"; ticketId: string; messageId: string }
  | { status: "appended"; ticketId: string; messageId: string }
  | { status: "dropped"; reason: InboundDropReason };

/** Test seams. Production passes none. */
export type ReceiveEmailDeps = {
  /** DNS for the DKIM check (default: system DNS through mailauth). */
  resolver?: DkimResolver;
  now?: () => Date;
};

const HOUR_MS = 60 * 60_000;
/** `References` entries (newest first) looked up for threading. */
const THREAD_REFERENCES = 20;
const REPLY_PREFIX = "support+";
const NO_SUBJECT = "(no subject)";
/** Longest Message-ID stored as sent; longer ones are stored hashed. */
const MESSAGE_ID_MAX = 255;

const dropped = (reason: InboundDropReason): InboundResult => ({
  status: "dropped",
  reason,
});

/**
 * Logs why a message was dropped, once per message: `warn`, or `info` for a
 * duplicate (a relay's retry of a message already stored is routine). Only
 * the reason and the sender's domain: no body, no address, no recipient (a
 * `support+<token>` recipient carries the reply token).
 */
function logDrop(
  rt: SupportRuntime,
  reason: InboundDropReason,
  senderDomain: string | null,
): void {
  const message = `[@byo-oss/support] dropped an inbound email: ${reason} (sender domain: ${senderDomain ?? "none"})`;
  try {
    if (reason === "duplicate") rt.opts.logger.info(message);
    else rt.opts.logger.warn(message);
  } catch {
    // a broken logger must not turn a decided drop into a retry
  }
}

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1);
}

/** The address in `"Acme Support <support@acme.com>"` (or the bare address), lowercased. */
function addressIn(value: string): string {
  const bracketed = /<([^<>]+)>/.exec(value);
  return lowerEmail(bracketed?.[1] ?? value);
}

/** Loop guard: mail from our own `from` address or from any address at `replyDomain`. */
function isOwnAddress(sender: string, email: ResolvedEmailOptions): boolean {
  return (
    sender === addressIn(email.from) || domainOf(sender) === email.replyDomain
  );
}

/**
 * RFC 3834 `Auto-Submitted` other than `no`, Exchange's
 * `X-Auto-Response-Suppress`, `Precedence: bulk|junk|auto_reply`, and the
 * `X-Autoreply`/`X-Autorespond` conventions.
 */
function isAutoReply(headers: Record<string, string>): boolean {
  const submitted = (headers["auto-submitted"] ?? "")
    .split(";")[0]
    ?.trim()
    .toLowerCase();
  if (submitted && submitted !== "no") return true;
  if (headers["x-auto-response-suppress"] !== undefined) return true;
  if (/^(bulk|junk|auto_reply)$/i.test((headers.precedence ?? "").trim())) {
    return true;
  }
  return (
    headers["x-autoreply"] !== undefined ||
    headers["x-autorespond"] !== undefined
  );
}

/**
 * The verdict SES adds on receipt (`X-SES-Spam-Verdict`,
 * `X-SES-Virus-Verdict`: `PASS`, `FAIL`, `GRAY` or `PROCESSING_FAILED`),
 * uppercased; null when absent. SES prepends its headers above everything
 * the sender wrote, so only the first copy is read: a copy the sender added
 * further down never overrides SES's. Without SES (scanning off, another
 * relay) the first copy may be the sender's; only `FAIL` is acted on, so it
 * can only make that sender's own message stricter.
 */
function sesVerdict(
  headers: Record<string, string>,
  name: "x-ses-spam-verdict" | "x-ses-virus-verdict",
): string | null {
  // parseMessage joins repeated headers with ", " in message order
  const first = headers[name]?.split(",")[0]?.trim().toUpperCase();
  return first || null;
}

/** The null return path `<>`, a `MAILER-DAEMON`/`postmaster` sender, or a delivery report. */
function isBounce(parsed: ParsedMessage, sender: string): boolean {
  if (parsed.returnPath === "") return true;
  const local = sender.slice(0, sender.lastIndexOf("@"));
  if (local === "mailer-daemon" || local === "postmaster") return true;
  return /^multipart\/report\b/i.test(
    (parsed.headers["content-type"] ?? "").trim(),
  );
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    data as Uint8Array<ArrayBuffer>,
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The Message-ID as stored and matched. One longer than 255 characters is
 * stored as a hash of itself (a unique index can't hold an arbitrarily long
 * value, and a message that can never be inserted would be retried forever);
 * mail without one gets a hash of its bytes, so a relay's retry of the same
 * message is still a duplicate.
 */
async function storedMessageId(
  messageId: string | null,
  raw: Uint8Array,
): Promise<string> {
  if (messageId && messageId.length <= MESSAGE_ID_MAX) return messageId;
  const hex = await sha256Hex(
    messageId ? new TextEncoder().encode(messageId) : raw,
  );
  return `<${hex}@inbound.invalid>`;
}

async function messageExists(
  rt: SupportRuntime,
  emailMessageId: string,
): Promise<boolean> {
  const row = await rt.adapter.findOne<SupportMessageRow>({
    model: "supportMessage",
    where: [{ field: "emailMessageId", value: emailMessageId }],
  });
  return row !== null;
}

/**
 * The cap this message hits, if any. Verified mail counts the sender's
 * verified email replies in the last hour (by account and by address);
 * unverified mail counts every unverified reply in the last hour. So forged
 * mail never uses up a real sender's cap.
 */
async function capReached(
  rt: SupportRuntime,
  input: {
    sender: string;
    account: UserSummary | null;
    verified: boolean;
    since: Date;
  },
): Promise<InboundDropReason | null> {
  const inbound = rt.opts.inbound;
  if (!inbound) return null;
  const recent: Where[] = [
    { field: "kind", value: "reply" },
    { field: "verified", value: input.verified },
    { field: "createdAt", operator: "gte", value: input.since },
  ];
  const count = (where: Where[]) =>
    rt.adapter.count({ model: "supportMessage", where: [...recent, ...where] });

  if (!input.verified) {
    const unverified = await count([]);
    return unverified >= inbound.maxUnverifiedPerHour ? "unverified_cap" : null;
  }
  // two queries rather than one OR, so a where list never mixes connectors
  const email: Where = { field: "channel", value: "email" };
  let sent = await count([
    email,
    { field: "authorEmail", value: input.sender },
  ]);
  if (input.account) {
    sent += await count([email, { field: "userId", value: input.account.id }]);
  }
  return sent >= inbound.maxPerSenderPerHour ? "sender_cap" : null;
}

/** The token of a `support+<token>@<replyDomain>` recipient, if any. */
function replyTokenOf(
  recipients: readonly string[],
  replyDomain: string,
): string | null {
  for (const recipient of recipients) {
    const at = recipient.lastIndexOf("@");
    if (at < 0 || recipient.slice(at + 1) !== replyDomain) continue;
    const local = recipient.slice(0, at).toLowerCase();
    if (!local.startsWith(REPLY_PREFIX)) continue;
    const token = local.slice(REPLY_PREFIX.length);
    if (isReplyToken(token)) return token;
  }
  return null;
}

/**
 * `In-Reply-To`, then `References` newest first, each with and without angle
 * brackets (a mailer may report its id either way), in their stored form.
 */
async function threadIds(parsed: ParsedMessage): Promise<string[]> {
  const ids = [
    ...(parsed.inReplyTo ? [parsed.inReplyTo] : []),
    ...parsed.references.slice(-THREAD_REFERENCES).reverse(),
  ];
  const forms: string[] = [];
  for (const id of ids) {
    const bare = id.replace(/^<|>$/g, "");
    if (!bare) continue;
    forms.push(await storedMessageId(`<${bare}>`, new Uint8Array()));
    if (bare.length <= MESSAGE_ID_MAX) forms.push(bare);
  }
  return [...new Set(forms)];
}

async function findTicket(
  rt: SupportRuntime,
  field: "id" | "replyToken",
  value: string,
): Promise<SupportTicketRow | null> {
  return rt.adapter.findOne<SupportTicketRow>({
    model: "supportTicket",
    where: [{ field, value }],
  });
}

/** The ticket this message replies to: reply token first, then a stored Message-ID. */
async function findThread(
  rt: SupportRuntime,
  parsed: ParsedMessage,
  replyDomain: string,
): Promise<SupportTicketRow | null> {
  const token = replyTokenOf(parsed.recipients, replyDomain);
  if (token) {
    const ticket = await findTicket(rt, "replyToken", token);
    if (ticket) return ticket;
  }
  const ids = await threadIds(parsed);
  if (ids.length === 0) return null;
  const rows = await findManyIn<SupportMessageRow>(rt.adapter, {
    model: "supportMessage",
    field: "emailMessageId",
    values: ids,
  });
  for (const id of ids) {
    const row = rows.find((message) => message.emailMessageId === id);
    if (!row) continue;
    const ticket = await findTicket(rt, "id", row.ticketId);
    if (ticket) return ticket;
  }
  return null;
}

/**
 * The append rule: verified mail from the requester (the account's verified
 * email, or the stored `requesterEmail`) or, on an organization-shared
 * ticket, from a member whose verified account has the sender's address.
 */
async function mayAppend(
  rt: SupportRuntime,
  ticket: SupportTicketRow,
  input: { sender: string; linked: UserSummary | null; verified: boolean },
): Promise<boolean> {
  if (!input.verified) return false;
  if (ticket.userId) {
    const requester = await findUserById(rt.adapter, ticket.userId);
    if (
      requester?.emailVerified &&
      lowerEmail(requester.email) === input.sender
    )
      return true;
  } else if (ticket.requesterEmail && ticket.requesterEmail === input.sender) {
    return true;
  }
  if (
    ticket.visibility === "organization" &&
    ticket.organizationId &&
    input.linked
  ) {
    const member = await findMember(rt.adapter, {
      userId: input.linked.id,
      organizationId: ticket.organizationId,
    });
    return member !== null;
  }
  return false;
}

/** A system event row (no author, never counted by the caps), on the email channel. */
async function addEvent(
  rt: SupportRuntime,
  ticket: SupportTicketRow,
  data: SupportEventData,
): Promise<void> {
  await addMessage(rt, {
    ticket,
    kind: "event",
    authorType: "system",
    body: "",
    data,
    // every event written here was caused by an inbound email
    channel: "email",
    verified: true,
    actorId: null,
  });
}

/** The part's filename for an event row: no path, at most 200 characters. */
function partName(part: SupportInboundPart): string {
  const base = (part.filename ?? "").split(/[\\/]/).pop()?.trim();
  return (base || "attachment").slice(0, SUPPORT_LIMITS.filename);
}

/** Stores each part; every refused part gets an `attachment_dropped` event. */
async function storeParts(
  rt: SupportRuntime,
  input: {
    ticket: SupportTicketRow;
    message: SupportMessageRow;
    userId: string | null;
    parts: readonly SupportInboundPart[];
  },
): Promise<void> {
  for (const part of input.parts) {
    let reason: string;
    try {
      const result = await storeInboundPart(rt, {
        ticket: input.ticket,
        messageId: input.message.id,
        userId: input.userId,
        part,
      });
      if (!("dropped" in result)) continue;
      reason = result.reason;
    } catch (error) {
      // the message is stored; losing a part must not make the relay retry it
      rt.context.logger.error(
        "[@byo-oss/support] could not store an inbound attachment",
        error,
      );
      reason = "storage_failed";
    }
    await addEvent(rt, input.ticket, {
      type: "attachment_dropped",
      to: `${reason}:${partName(part)}`,
    });
  }
}

/**
 * Handles one raw inbound message: size cap, parse, drop rules (SES virus
 * verdict `FAIL`, loop guard, auto-replies, bounces, duplicate Message-ID
 * incl. a unique-constraint failure), caps, DKIM alignment (an SES spam
 * verdict `FAIL` counts as unverified), threading (reply token in a
 * `support+<token>@<replyDomain>` recipient, lowercased; then
 * `In-Reply-To`/`References`; then a new ticket when `newTickets`), merged
 * targets via `resolveMergedTicket`, the append rule, follow-up tickets for
 * closed ones (`followup_of` event), attachment parts through
 * `storeInboundPart` (writing an `attachment_dropped` event for each drop).
 * Never throws for a message it decided to drop, and logs each drop once
 * through `opts.logger` (reason and sender domain only).
 *
 * Mail that threads but may not append (unverified, or not from the
 * requester) opens a new private, organization-less ticket and never links
 * to the thread. Only verified mail from a verified account is stored with
 * that account's `userId`; anything else keeps the sender's address.
 */
export async function receiveEmail(
  rt: SupportRuntime,
  raw: Uint8Array,
  deps: ReceiveEmailDeps = {},
): Promise<InboundResult> {
  const { inbound, email } = rt.opts;
  if (!inbound || !email) {
    throw new Error(
      "[@byo-oss/support] receiveEmail needs the inbound and email options",
    );
  }
  let senderDomain: string | null = null;
  const drop = (reason: InboundDropReason): InboundResult => {
    logDrop(rt, reason, senderDomain);
    return dropped(reason);
  };
  if (raw.byteLength > inbound.maxBytes) return drop("too_large");

  let parsed: ParsedMessage;
  try {
    parsed = await parseMessage(raw);
  } catch {
    return drop("unparseable");
  }
  const sender = parsed.from?.address;
  if (sender?.includes("@")) senderDomain = domainOf(sender);
  // nothing of a message SES found a virus in is stored, parts included
  if (sesVerdict(parsed.headers, "x-ses-virus-verdict") === "FAIL") {
    return drop("virus");
  }
  if (!sender?.includes("@")) return drop("no_sender");
  if (isOwnAddress(sender, email)) return drop("loop");
  if (isAutoReply(parsed.headers)) return drop("auto_reply");
  if (isBounce(parsed, sender)) return drop("bounce");

  const emailMessageId = await storedMessageId(parsed.messageId, raw);
  if (await messageExists(rt, emailMessageId)) return drop("duplicate");

  // mail SES marked as spam counts as unverified whatever its DKIM says: it
  // never appends to a ticket, never links to an account and falls under
  // the unverified cap
  const spam = sesVerdict(parsed.headers, "x-ses-spam-verdict") === "FAIL";
  const verified =
    !spam &&
    (await verifyAlignedDkim(raw, domainOf(sender), {
      resolver: deps.resolver,
    }));
  const account = await findUserByEmail(rt.adapter, sender);
  // only verified mail from a verified account is that account's
  const linked = verified && account?.emailVerified ? account : null;

  const now = deps.now?.() ?? new Date();
  const cap = await capReached(rt, {
    sender,
    account,
    verified,
    since: new Date(now.getTime() - HOUR_MS),
  });
  if (cap) return drop(cap);

  const thread = await findThread(rt, parsed, email.replyDomain);
  const target = thread ? await resolveMergedTicket(rt.adapter, thread) : null;
  const allowed = target
    ? await mayAppend(rt, target, { sender, linked, verified })
    : false;

  const userId = linked?.id ?? null;
  const name = parsed.from?.name ?? null;
  const body = parsed.text.slice(0, SUPPORT_LIMITS.body);

  // a unique-constraint failure on the message insert is a concurrent
  // duplicate: createTicket removes its ticket and addMessage writes nothing
  // else before the insert, so nothing is left behind
  const orDuplicate = async <T>(write: () => Promise<T>): Promise<T | null> => {
    try {
      return await write();
    } catch (error) {
      if (await messageExists(rt, emailMessageId)) return null;
      throw error;
    }
  };

  if (target && allowed && target.status !== "closed") {
    const appended = await orDuplicate(() =>
      addMessage(rt, {
        ticket: target,
        kind: "reply",
        authorType: "customer",
        userId,
        authorEmail: linked ? null : sender,
        authorName: linked ? null : name,
        body,
        channel: "email",
        verified,
        emailMessageId,
        actorId: userId,
      }),
    );
    if (!appended) return drop("duplicate");
    await storeParts(rt, {
      ticket: appended.ticket,
      message: appended.message,
      userId,
      parts: parsed.attachments,
    });
    return {
      status: "appended",
      ticketId: appended.ticket.id,
      messageId: appended.message.id,
    };
  }

  // a requester's reply to a closed ticket threads, so it opens its
  // follow-up even when newTickets is off
  const followup = target !== null && allowed;
  if (!followup && !inbound.newTickets) return drop("no_new_tickets");
  const created = await orDuplicate(() =>
    createTicket(rt, {
      subject: parsed.subject.slice(0, SUPPORT_LIMITS.subject) || NO_SUBJECT,
      body,
      channel: "email",
      userId,
      requesterEmail: linked ? null : sender,
      requesterName: linked ? null : name,
      organizationId: null,
      visibility: "private",
      verified,
      emailMessageId,
      actorId: userId,
    }),
  );
  if (!created) return drop("duplicate");
  // a reply to a closed ticket from someone who could have appended to it
  if (followup && target) {
    await addEvent(rt, created.ticket, {
      type: "followup_of",
      from: target.id,
    });
  }
  await storeParts(rt, {
    ticket: created.ticket,
    message: created.message,
    userId,
    parts: parsed.attachments,
  });
  return {
    status: "created",
    ticketId: created.ticket.id,
    messageId: created.message.id,
  };
}
