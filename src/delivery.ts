import { isPermanentMailError } from "@byo-oss/mailer";
import type { Where } from "better-auth";
import {
  findManyIn,
  findUsersByIds,
  type SupportRuntime,
  type UserSummary,
} from "./adapter";
import { pruneUploads } from "./attachments";
import type {
  SupportDeliveryRow,
  SupportMessageRow,
  SupportTicketRow,
} from "./schema";
import { applyStatus } from "./tickets";

/** What one sweep did. A `type` alias, so it assigns to `ByoSweepResult`. */
export type SupportSweepResult = {
  sent: number;
  skipped: number;
  retrying: number;
  failed: number;
  hasMore: boolean;
  /** Solved tickets closed after `autoCloseAfter`. */
  closed: number;
  /** Unattached uploads older than 24 h deleted. */
  pruned: number;
};

/** Why a delivery was skipped, stored in `detail`. */
export type SupportSkipReason =
  | "seen"
  | "note"
  | "not_a_reply"
  | "no_address"
  | "deleted";

const BACKOFF_BASE = 60_000;
const BACKOFF_MAX = 60 * 60_000;
/** Ticket groups sent side by side; each group sends in order. */
const CONCURRENCY = 10;
/** Recent messages read for `In-Reply-To`/`References`. */
const THREAD_LOOKBACK = 100;
/** Message-IDs listed in `References`, newest kept. */
const MAX_REFERENCES = 10;

type Outcome = "sent" | "skipped" | "retrying" | "failed";
type DeliveryData = Omit<SupportDeliveryRow, "id">;

/**
 * After an agent `reply` (never a note): with a mailer, inserts one
 * `supportDelivery` (`pending`, due after `email.replyDelay`). When the delay
 * is 0 and `advanced.backgroundTasks.handler` exists, hands the send to it
 * (SPEC §5.4). No mailer: no-op.
 */
export async function enqueueReply(
  rt: SupportRuntime,
  input: { ticket: SupportTicketRow; message: SupportMessageRow },
): Promise<void> {
  const { opts } = rt;
  const { ticket, message } = input;
  if (!opts.mailer || !opts.email) return;
  if (message.kind !== "reply" || message.authorType !== "agent") return;

  const now = new Date();
  const delivery = await rt.adapter.create<DeliveryData, SupportDeliveryRow>({
    model: "supportDelivery",
    data: {
      messageId: message.id,
      ticketId: ticket.id,
      status: "pending",
      scheduledFor: new Date(now.getTime() + opts.email.replyDelay),
      claimedAt: null,
      attempts: 0,
      detail: null,
      providerId: null,
      createdAt: now,
    },
  });

  // Without a handler runInBackgroundOrAwait awaits, which would hold the
  // reply open for the send; the sweep picks the row up instead. Inside a
  // transaction the row isn't committed yet, so the sweep sends it later.
  const inTransaction = rt.adapter !== rt.context.adapter;
  if (
    opts.email.replyDelay === 0 &&
    !inTransaction &&
    rt.context.options.advanced?.backgroundTasks?.handler
  ) {
    await rt.context.runInBackgroundOrAwait(
      attemptDeliveries(rt, [delivery], now).catch((error) => {
        rt.context.logger.error(
          `[@byo-oss/support] immediate send of delivery ${delivery.id} failed`,
          error,
        );
      }),
    );
  }
}

/**
 * One sweep: reclaim stale `sending` rows (or fail them at `maxAttempts`),
 * claim and send due `pending` rows (at most `batchSize`), close solved
 * tickets past `autoCloseAfter`, and prune old unattached uploads through
 * `pruneUploads`. Without a mailer only the last two run.
 */
export async function runSweep(
  rt: SupportRuntime,
  now: Date = new Date(),
): Promise<SupportSweepResult> {
  const result: SupportSweepResult = {
    sent: 0,
    skipped: 0,
    retrying: 0,
    failed: 0,
    hasMore: false,
    closed: 0,
    pruned: 0,
  };

  if (rt.opts.mailer) {
    await reclaimStale(rt, now);
    const limit = rt.opts.batchSize;
    const due = await rt.adapter.findMany<SupportDeliveryRow>({
      model: "supportDelivery",
      where: [
        { field: "status", value: "pending" },
        { field: "scheduledFor", operator: "lte", value: now },
      ],
      sortBy: { field: "scheduledFor", direction: "asc" },
      limit: limit + 1,
    });
    const counts = await attemptDeliveries(rt, due.slice(0, limit), now);
    Object.assign(result, counts);
    result.hasMore = due.length > limit;
  }

  const closed = await closeSolvedTickets(rt, now);
  result.closed = closed.closed;
  result.hasMore ||= closed.hasMore;
  result.pruned = await pruneUploads(rt, now);
  return result;
}

/**
 * A worker that died mid-send leaves its row in `sending`. Release it so the
 * claim can stay a plain status guard, unless it has used up its attempts: a
 * send that keeps getting killed would loop forever.
 */
async function reclaimStale(rt: SupportRuntime, now: Date): Promise<void> {
  const stale: Where[] = [
    { field: "status", value: "sending" },
    {
      field: "claimedAt",
      operator: "lt",
      value: new Date(now.getTime() - rt.opts.leaseMs),
    },
  ];
  await rt.adapter.updateMany({
    model: "supportDelivery",
    where: [
      ...stale,
      { field: "attempts", operator: "gte", value: rt.opts.maxAttempts },
    ],
    update: { status: "failed", detail: "send did not finish" },
  });
  await rt.adapter.updateMany({
    model: "supportDelivery",
    where: stale,
    update: { status: "pending" },
  });
}

/** Closes up to `batchSize` tickets solved more than `autoCloseAfter` ago. */
async function closeSolvedTickets(
  rt: SupportRuntime,
  now: Date,
): Promise<{ closed: number; hasMore: boolean }> {
  const limit = rt.opts.batchSize;
  const solved = await rt.adapter.findMany<SupportTicketRow>({
    model: "supportTicket",
    where: [
      { field: "status", value: "solved" },
      {
        field: "solvedAt",
        operator: "lt",
        value: new Date(now.getTime() - rt.opts.autoCloseAfter),
      },
    ],
    sortBy: { field: "solvedAt", direction: "asc" },
    limit: limit + 1,
  });
  let closed = 0;
  for (const ticket of solved.slice(0, limit)) {
    await applyStatus(rt, {
      ticket,
      to: "closed",
      actorId: null,
      authorType: "system",
    });
    closed++;
  }
  return { closed, hasMore: solved.length > limit };
}

type Loaded = {
  messages: Map<string, SupportMessageRow>;
  tickets: Map<string, SupportTicketRow>;
  users: Map<string, UserSummary>;
};

async function attemptDeliveries(
  rt: SupportRuntime,
  deliveries: SupportDeliveryRow[],
  now: Date,
): Promise<Pick<SupportSweepResult, Outcome>> {
  const result = { sent: 0, skipped: 0, retrying: 0, failed: 0 };
  if (deliveries.length === 0) return result;

  // batchSize may exceed findMany's default 100 rows and D1's 100 parameters
  const [messages, tickets] = await Promise.all([
    findManyIn<SupportMessageRow>(rt.adapter, {
      model: "supportMessage",
      field: "id",
      values: deliveries.map((d) => d.messageId),
    }),
    findManyIn<SupportTicketRow>(rt.adapter, {
      model: "supportTicket",
      field: "id",
      values: deliveries.map((d) => d.ticketId),
    }),
  ]);
  // read now, at send time, so a changed or newly verified email is used
  const users = await findUsersByIds(
    rt.adapter,
    tickets.map((t) => t.userId),
  );
  const loaded: Loaded = {
    messages: new Map(messages.map((m) => [m.id, m])),
    tickets: new Map(tickets.map((t) => [t.id, t])),
    users,
  };

  // Rows of one ticket send in order, so a later reply can thread under the
  // Message-ID an earlier one stored. Tickets run side by side.
  const groups = new Map<string, SupportDeliveryRow[]>();
  for (const delivery of deliveries) {
    const group = groups.get(delivery.ticketId);
    if (group) group.push(delivery);
    else groups.set(delivery.ticketId, [delivery]);
  }
  const queue = [...groups.values()];
  for (let i = 0; i < queue.length; i += CONCURRENCY) {
    await Promise.all(
      queue.slice(i, i + CONCURRENCY).map(async (group) => {
        for (const delivery of group) {
          const outcome = await attemptDelivery(rt, delivery, loaded, now);
          if (outcome) result[outcome]++;
        }
      }),
    );
  }
  return result;
}

async function attemptDelivery(
  rt: SupportRuntime,
  delivery: SupportDeliveryRow,
  loaded: Loaded,
  now: Date,
): Promise<Outcome | null> {
  const { mailer, email } = rt.opts;
  if (!mailer || !email) return null;

  // The immediate path and a sweep can both hold this row. incrementOne is the
  // adapter's atomic claim (every first-party adapter guards it: a guarded
  // UPDATE, a row lock or a single-process write), so exactly one caller gets
  // it back.
  const claimed = await rt.adapter.incrementOne<SupportDeliveryRow>({
    model: "supportDelivery",
    where: [
      { field: "id", value: delivery.id },
      { field: "status", value: "pending" },
      { field: "scheduledFor", operator: "lte", value: now },
    ],
    increment: { attempts: 1 },
    set: { status: "sending", claimedAt: now },
  });
  if (!claimed) return null;

  const finish = (update: Partial<DeliveryData>) =>
    rt.adapter.update({
      model: "supportDelivery",
      where: [{ field: "id", value: delivery.id }],
      update,
    });
  const skip = async (detail: SupportSkipReason) => {
    await finish({ status: "skipped", detail });
    return "skipped" as const;
  };

  const message = loaded.messages.get(delivery.messageId);
  const ticket = loaded.tickets.get(delivery.ticketId);
  if (!message || !ticket) return skip("deleted");
  if (message.kind === "note") return skip("note");
  if (message.kind !== "reply" || message.authorType !== "agent")
    return skip("not_a_reply");
  if (
    ticket.requesterSeenAt &&
    new Date(ticket.requesterSeenAt).getTime() >=
      new Date(message.createdAt).getTime()
  )
    return skip("seen");
  const to = recipient(ticket, loaded.users, email.requireVerifiedEmail);
  if (!to) return skip("no_address");

  const link = `${email.appUrl}${email.ticketPath(ticket.id)}`;
  const thread = await threadHeaders(rt, message);
  let sent: { id: string; messageId?: string };
  try {
    sent = await mailer.send({
      to,
      subject: `[#${ticket.number}] ${ticket.subject}`.replace(/[\r\n]+/g, " "),
      text: `${message.body}\n\n---\nView this ticket: ${link}\nReply to this email to answer.`,
      html: renderHtml(message.body, link),
      replyTo: `support+${ticket.replyToken}@${email.replyDomain}`,
      ...(thread ? { headers: thread } : {}),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    rt.context.logger.error(
      `[@byo-oss/support] delivery ${delivery.id} failed: ${detail}`,
    );
    if (
      isPermanentMailError(error) ||
      claimed.attempts >= rt.opts.maxAttempts
    ) {
      await finish({ status: "failed", detail });
      return "failed";
    }
    const backoff = Math.min(
      BACKOFF_BASE * 2 ** (claimed.attempts - 1),
      BACKOFF_MAX,
    );
    await finish({
      status: "pending",
      scheduledFor: new Date(now.getTime() + backoff),
      detail,
    });
    return "retrying";
  }

  await finish({ status: "sent", providerId: sent.id, detail: null });
  if (sent.messageId) {
    // The provider may replace our Message-ID; store the one it sent so
    // inbound replies can thread by In-Reply-To/References too.
    try {
      await rt.adapter.update({
        model: "supportMessage",
        where: [{ field: "id", value: message.id }],
        update: { emailMessageId: sent.messageId },
      });
    } catch (error) {
      rt.context.logger.error(
        `[@byo-oss/support] could not store the Message-ID of delivery ${delivery.id}`,
        error,
      );
    }
  }
  return "sent";
}

/**
 * The requester's address, resolved now: the account's email when verified
 * (or when `requireVerifiedEmail` is off), else the account-less
 * `requesterEmail`.
 */
function recipient(
  ticket: SupportTicketRow,
  users: Map<string, UserSummary>,
  requireVerifiedEmail: boolean,
): string | null {
  const user = ticket.userId ? users.get(ticket.userId) : undefined;
  if (user?.email && (user.emailVerified || !requireVerifiedEmail))
    return user.email;
  return ticket.requesterEmail || null;
}

const bracketed = (id: string) => {
  const trimmed = id.trim();
  return trimmed.startsWith("<") ? trimmed : `<${trimmed}>`;
};

/**
 * `In-Reply-To` (the newest stored Message-ID before this message) and
 * `References` (up to the last 10, oldest first), or undefined when the
 * thread has none.
 */
async function threadHeaders(
  rt: SupportRuntime,
  message: SupportMessageRow,
): Promise<Record<string, string> | undefined> {
  const recent = await rt.adapter.findMany<SupportMessageRow>({
    model: "supportMessage",
    where: [
      { field: "ticketId", value: message.ticketId },
      { field: "createdAt", operator: "lte", value: message.createdAt },
    ],
    sortBy: { field: "createdAt", direction: "desc" },
    limit: THREAD_LOOKBACK,
  });
  const ids = recent
    .filter((m) => m.id !== message.id && m.emailMessageId)
    .slice(0, MAX_REFERENCES)
    .map((m) => bracketed(m.emailMessageId as string))
    .reverse();
  const last = ids.at(-1);
  if (!last) return undefined;
  return { "In-Reply-To": last, References: ids.join(" ") };
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] as string);

/** The plain-text body, escaped, with line breaks kept and the ticket link. */
function renderHtml(body: string, link: string): string {
  const paragraphs = escapeHtml(body).replace(/\r?\n/g, "<br>");
  const href = escapeHtml(link);
  return `<div>${paragraphs}</div><hr><p><a href="${href}">View this ticket</a>. Reply to this email to answer.</p>`;
}
