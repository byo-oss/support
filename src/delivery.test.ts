import {
  type Mailer,
  type MailMessage,
  type MemoryMailer,
  memoryMailer,
  PermanentMailError,
} from "@byo-oss/mailer";
import type { BetterAuthOptions } from "better-auth";
import { describe, expect, it } from "vitest";
import { authRuntime, type SupportRuntime } from "./adapter";
import { enqueueReply, runSweep } from "./delivery";
import type { SupportOptions } from "./options";
import type {
  SupportDeliveryRow,
  SupportMessageRow,
  SupportTicketRow,
} from "./schema";
import {
  createTestAuth,
  getContext,
  insertMessage,
  insertTicket,
  signUpUser,
  type TestAuth,
} from "./test-utils";
import { addMessage, createTicket, markSeen } from "./tickets";

const AGENT = "user_agent";
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const DELAY = 2 * MINUTE;

const EMAIL = {
  from: "Support <support@vendor.test>",
  replyDomain: "Reply.Vendor.test",
  appUrl: "https://app.vendor.test/",
};

async function setup(
  options: Omit<SupportOptions, "mailer"> & { mailer?: Mailer | null } = {},
  authOptions?: Partial<BetterAuthOptions>,
) {
  const mailer =
    options.mailer === null ? undefined : (options.mailer ?? memoryMailer());
  const { mailer: _ignored, email, ...rest } = options;
  const auth = createTestAuth(
    {
      ...rest,
      ...(mailer
        ? { mailer, email: { ...EMAIL, replyDelay: DELAY, ...email } }
        : {}),
    },
    { authOptions },
  );
  const rt = await authRuntime(auth, "delivery.test");
  return { auth, rt, mailer };
}

const later = (ms: number) => new Date(Date.now() + ms);

/**
 * Lets the clock move on, so rows written next get a later `createdAt` than
 * the ones before (seen marks and thread order compare timestamps).
 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 3));

/** A web ticket from a signed-up requester (verified unless told otherwise). */
async function webTicket(
  auth: TestAuth,
  rt: SupportRuntime,
  input: { email?: string; verified?: boolean; subject?: string } = {},
) {
  const requester = await signUpUser(auth, input.email ?? "cora@acme.test", {
    verified: input.verified ?? true,
  });
  const { ticket } = await createTicket(rt, {
    subject: input.subject ?? "Printer on fire",
    body: "Help",
    channel: "web",
    userId: requester.user.id,
    verified: true,
    actorId: requester.user.id,
  });
  return { ticket, requester };
}

/** An agent reply (or note), enqueued as the agent route does. */
async function agentPost(
  rt: SupportRuntime,
  ticket: SupportTicketRow,
  input: { body?: string; kind?: "reply" | "note" } = {},
) {
  await tick();
  const posted = await addMessage(rt, {
    ticket,
    kind: input.kind ?? "reply",
    authorType: "agent",
    userId: AGENT,
    body: input.body ?? "On it",
    channel: "web",
    verified: true,
    actorId: AGENT,
  });
  await enqueueReply(rt, posted);
  return posted;
}

const deliveries = (rt: SupportRuntime) =>
  rt.adapter.findMany<SupportDeliveryRow>({
    model: "supportDelivery",
    where: [],
    sortBy: { field: "createdAt", direction: "asc" },
    limit: 1000,
  });

async function onlyDelivery(rt: SupportRuntime) {
  const rows = await deliveries(rt);
  expect(rows).toHaveLength(1);
  return rows[0] as SupportDeliveryRow;
}

const setDelivery = (
  rt: SupportRuntime,
  id: string,
  update: Partial<SupportDeliveryRow>,
) =>
  rt.adapter.update({
    model: "supportDelivery",
    where: [{ field: "id", value: id }],
    update,
  });

const reloadTicket = async (rt: SupportRuntime, id: string) =>
  (await rt.adapter.findOne<SupportTicketRow>({
    model: "supportTicket",
    where: [{ field: "id", value: id }],
  })) as SupportTicketRow;

const reloadMessage = async (rt: SupportRuntime, id: string) =>
  (await rt.adapter.findOne<SupportMessageRow>({
    model: "supportMessage",
    where: [{ field: "id", value: id }],
  })) as SupportMessageRow;

/** A mailer that fails for chosen recipients: `retry@…` temporarily, `perm@…` permanently. */
function routingMailer() {
  const sent: MailMessage[] = [];
  const mailer: Mailer = {
    async send(message) {
      const to = String(message.to);
      if (to.startsWith("retry@")) throw new Error("throttled");
      if (to.startsWith("perm@")) throw new PermanentMailError("bad address");
      sent.push(message);
      return { id: `id-${sent.length}` };
    },
  };
  return { mailer, sent };
}

const ZERO = {
  sent: 0,
  skipped: 0,
  retrying: 0,
  failed: 0,
  hasMore: false,
  closed: 0,
  pruned: 0,
};

describe("enqueueReply", () => {
  it("queues one pending delivery due after replyDelay for an agent reply", async () => {
    const { auth, rt } = await setup();
    const { ticket } = await webTicket(auth, rt);
    const before = Date.now();
    const { message } = await agentPost(rt, ticket);
    const row = await onlyDelivery(rt);
    expect(row).toMatchObject({
      messageId: message.id,
      ticketId: ticket.id,
      status: "pending",
      attempts: 0,
    });
    const due = new Date(row.scheduledFor).getTime();
    expect(due).toBeGreaterThanOrEqual(before + DELAY);
    expect(due).toBeLessThanOrEqual(Date.now() + DELAY);
  });

  it("never queues a note or a customer reply", async () => {
    const { auth, rt } = await setup();
    const { ticket, requester } = await webTicket(auth, rt);
    await agentPost(rt, ticket, { kind: "note" });
    const customer = await addMessage(rt, {
      ticket,
      kind: "reply",
      authorType: "customer",
      userId: requester.user.id,
      body: "Any news?",
      channel: "web",
      verified: true,
      actorId: requester.user.id,
    });
    await enqueueReply(rt, customer);
    expect(await deliveries(rt)).toHaveLength(0);
  });

  it("does nothing without a mailer (no supportDelivery table)", async () => {
    const { auth, rt } = await setup({ mailer: null });
    const { ticket } = await webTicket(auth, rt);
    await expect(agentPost(rt, ticket)).resolves.toBeDefined();
    const context = await getContext(auth);
    expect(context.tables.supportDelivery).toBeUndefined();
  });

  it("sends inline through backgroundTasks.handler when replyDelay is 0", async () => {
    const background: Promise<unknown>[] = [];
    const { auth, rt, mailer } = await setup(
      { email: { ...EMAIL, replyDelay: 0 } },
      {
        advanced: {
          backgroundTasks: { handler: (p) => void background.push(p) },
        },
      },
    );
    const { ticket } = await webTicket(auth, rt);
    await agentPost(rt, ticket);
    expect(background).toHaveLength(1);
    await Promise.all(background);
    const sent = (mailer as MemoryMailer).sent;
    expect(sent).toHaveLength(1);
    expect((await onlyDelivery(rt)).status).toBe("sent");
  });

  it("leaves a replyDelay 0 row to the sweep without a background handler", async () => {
    const { auth, rt, mailer } = await setup({
      email: { ...EMAIL, replyDelay: 0 },
    });
    const { ticket } = await webTicket(auth, rt);
    await agentPost(rt, ticket);
    const memory = mailer as MemoryMailer;
    expect(memory.sent).toHaveLength(0);
    expect((await onlyDelivery(rt)).status).toBe("pending");
    expect(await runSweep(rt)).toMatchObject({ sent: 1 });
    expect(memory.sent).toHaveLength(1);
  });
});

describe("runSweep: sending", () => {
  it("honours replyDelay: nothing before it, sent after", async () => {
    const { auth, rt, mailer } = await setup();
    const { ticket } = await webTicket(auth, rt);
    await agentPost(rt, ticket);
    const memory = mailer as MemoryMailer;

    expect(await runSweep(rt, later(DELAY - 5_000))).toEqual(ZERO);
    expect(memory.sent).toHaveLength(0);

    expect(await runSweep(rt, later(DELAY + 1_000))).toEqual({
      ...ZERO,
      sent: 1,
    });
    expect(memory.sent).toHaveLength(1);
    const row = await onlyDelivery(rt);
    expect(row).toMatchObject({
      status: "sent",
      attempts: 1,
      providerId: "mem-1",
    });
    expect(row.detail ?? null).toBeNull();
  });

  it("builds the mail: subject, to, replyTo token, text and escaped html with the ticket link", async () => {
    const { auth, rt, mailer } = await setup();
    const { ticket } = await webTicket(auth, rt, {
      subject: "Invoice <b>wrong</b>",
    });
    await agentPost(rt, ticket, {
      body: 'Use <script>x</script> & "y"\nThanks',
    });
    await runSweep(rt, later(DELAY + 1_000));
    const [mail] = (mailer as MemoryMailer).sent;
    const link = `https://app.vendor.test/support/${ticket.id}`;
    expect(mail?.to).toBe("cora@acme.test");
    expect(mail?.subject).toBe(`[#${ticket.number}] Invoice <b>wrong</b>`);
    expect(mail?.replyTo).toBe(
      `support+${ticket.replyToken}@reply.vendor.test`,
    );
    expect(mail?.headers).toBeUndefined(); // no stored Message-ID yet
    expect(mail?.text).toContain('Use <script>x</script> & "y"\nThanks');
    expect(mail?.text).toContain(link);
    expect(mail?.html).toContain(
      "Use &lt;script&gt;x&lt;/script&gt; &amp; &quot;y&quot;<br>Thanks",
    );
    expect(mail?.html).not.toContain("<script>");
    expect(mail?.html).toContain(`href="${link}"`);
  });

  it("uses a custom ticketPath for the link", async () => {
    const { auth, rt, mailer } = await setup({
      email: { ...EMAIL, ticketPath: (id) => `/help/t/${id}` },
    });
    const { ticket } = await webTicket(auth, rt);
    await agentPost(rt, ticket);
    await runSweep(rt, later(DELAY + 1_000));
    const [mail] = (mailer as MemoryMailer).sent;
    expect(mail?.text).toContain(`https://app.vendor.test/help/t/${ticket.id}`);
  });

  it("threads with In-Reply-To/References from stored Message-IDs and stores the returned messageId", async () => {
    const mailer = memoryMailer({ reportMessageId: true });
    const { rt } = await setup({ mailer });
    const { ticket } = await createTicket(rt, {
      subject: "From email",
      body: "Hi",
      channel: "email",
      requesterEmail: "Guest@Example.test",
      verified: true,
      emailMessageId: "<in-1@example.test>",
      actorId: null,
    });

    const first = await agentPost(rt, ticket, { body: "First" });
    await runSweep(rt, later(DELAY + 1_000));
    const second = await agentPost(rt, first.ticket, { body: "Second" });
    await runSweep(rt, later(2 * DELAY + 2_000));

    const [one, two] = mailer.sent;
    expect(one?.to).toBe("guest@example.test");
    expect(one?.headers).toEqual({
      "In-Reply-To": "<in-1@example.test>",
      References: "<in-1@example.test>",
    });
    expect((await reloadMessage(rt, first.message.id)).emailMessageId).toBe(
      "<mem-1@memory.invalid>",
    );
    expect(two?.headers).toEqual({
      "In-Reply-To": "<mem-1@memory.invalid>",
      References: "<in-1@example.test> <mem-1@memory.invalid>",
    });
    expect((await reloadMessage(rt, second.message.id)).emailMessageId).toBe(
      "<mem-2@memory.invalid>",
    );
    // never in headers: Reply-To has its own field
    expect(Object.keys(two?.headers ?? {})).not.toContain("Reply-To");
  });

  it("leaves emailMessageId null when the mailer reports none", async () => {
    const { auth, rt } = await setup();
    const { ticket } = await webTicket(auth, rt);
    const { message } = await agentPost(rt, ticket);
    await runSweep(rt, later(DELAY + 1_000));
    expect(
      (await reloadMessage(rt, message.id)).emailMessageId ?? null,
    ).toBeNull();
  });

  it("mails an account-less requester at requesterEmail", async () => {
    const { rt, mailer } = await setup();
    const { ticket } = await createTicket(rt, {
      subject: "No account",
      body: "Hi",
      channel: "email",
      requesterEmail: "walk-in@example.test",
      verified: false,
      actorId: null,
    });
    await agentPost(rt, ticket);
    expect(await runSweep(rt, later(DELAY + 1_000))).toMatchObject({ sent: 1 });
    expect((mailer as MemoryMailer).sent[0]?.to).toBe("walk-in@example.test");
  });

  it("resolves the address at send time (a changed user email is used)", async () => {
    const { auth, rt, mailer } = await setup();
    const { ticket, requester } = await webTicket(auth, rt);
    await agentPost(rt, ticket);
    const context = await getContext(auth);
    await context.internalAdapter.updateUser(requester.user.id, {
      email: "cora.new@acme.test",
    });
    await runSweep(rt, later(DELAY + 1_000));
    expect((mailer as MemoryMailer).sent[0]?.to).toBe("cora.new@acme.test");
  });
});

describe("runSweep: skips", () => {
  it("skips when the requester has seen the ticket since the message", async () => {
    const { auth, rt, mailer } = await setup();
    const { ticket } = await webTicket(auth, rt);
    const { message } = await agentPost(rt, ticket);
    await markSeen(rt, {
      ticketId: ticket.id,
      side: "requester",
      at: new Date(new Date(message.createdAt).getTime() + 1_000),
    });
    expect(await runSweep(rt, later(DELAY + 1_000))).toEqual({
      ...ZERO,
      skipped: 1,
    });
    expect((mailer as MemoryMailer).sent).toHaveLength(0);
    expect(await onlyDelivery(rt)).toMatchObject({
      status: "skipped",
      detail: "seen",
    });
  });

  it("still sends when the requester last saw the ticket before the message", async () => {
    const { auth, rt } = await setup();
    const { ticket } = await webTicket(auth, rt);
    const { message } = await agentPost(rt, ticket);
    await markSeen(rt, {
      ticketId: ticket.id,
      side: "requester",
      at: new Date(new Date(message.createdAt).getTime() - 1_000),
    });
    expect(await runSweep(rt, later(DELAY + 1_000))).toMatchObject({ sent: 1 });
  });

  it("never mails a note, even with a delivery row", async () => {
    const { auth, rt, mailer } = await setup();
    const { ticket } = await webTicket(auth, rt);
    const note = await insertMessage(auth, {
      ticketId: ticket.id,
      kind: "note",
      authorType: "agent",
      userId: AGENT,
    });
    await rt.adapter.create({
      model: "supportDelivery",
      data: {
        messageId: note.id,
        ticketId: ticket.id,
        status: "pending",
        scheduledFor: new Date(),
        attempts: 0,
        createdAt: new Date(),
      },
    });
    expect(await runSweep(rt, later(1_000))).toEqual({ ...ZERO, skipped: 1 });
    expect((mailer as MemoryMailer).sent).toHaveLength(0);
    expect(await onlyDelivery(rt)).toMatchObject({
      status: "skipped",
      detail: "note",
    });
  });

  it("skips an unverified account email (no_address)", async () => {
    const { auth, rt, mailer } = await setup();
    const { ticket } = await webTicket(auth, rt, { verified: false });
    await agentPost(rt, ticket);
    expect(await runSweep(rt, later(DELAY + 1_000))).toEqual({
      ...ZERO,
      skipped: 1,
    });
    expect((mailer as MemoryMailer).sent).toHaveLength(0);
    expect(await onlyDelivery(rt)).toMatchObject({
      status: "skipped",
      detail: "no_address",
    });
  });

  it("sends to an unverified account email when requireVerifiedEmail is false", async () => {
    const { auth, rt, mailer } = await setup({
      email: { ...EMAIL, requireVerifiedEmail: false },
    });
    const { ticket } = await webTicket(auth, rt, { verified: false });
    await agentPost(rt, ticket);
    expect(await runSweep(rt, later(DELAY + 1_000))).toMatchObject({ sent: 1 });
    expect((mailer as MemoryMailer).sent[0]?.to).toBe("cora@acme.test");
  });

  it("skips a ticket with no address at all", async () => {
    const { auth, rt } = await setup();
    const ticket = await insertTicket(auth, { userId: null });
    await agentPost(rt, ticket);
    await runSweep(rt, later(DELAY + 1_000));
    expect(await onlyDelivery(rt)).toMatchObject({
      status: "skipped",
      detail: "no_address",
    });
  });
});

describe("runSweep: retries and leases", () => {
  it("backs off 1 min doubling to 1 h, then fails after maxAttempts", async () => {
    const mailer = memoryMailer({ fail: "retry" });
    const { auth, rt } = await setup({ mailer, maxAttempts: 9 });
    const { ticket } = await webTicket(auth, rt);
    await agentPost(rt, ticket);
    let at = later(DELAY + 1_000);
    const gaps: number[] = [];
    for (let attempt = 1; attempt < 9; attempt++) {
      expect(await runSweep(rt, at)).toEqual({ ...ZERO, retrying: 1 });
      const row = await onlyDelivery(rt);
      expect(row).toMatchObject({
        status: "pending",
        attempts: attempt,
        detail: "memoryMailer: temporary failure",
      });
      const next = new Date(row.scheduledFor);
      gaps.push((next.getTime() - at.getTime()) / MINUTE);
      // not due a moment before the backoff ends
      expect(await runSweep(rt, new Date(next.getTime() - 1))).toEqual(ZERO);
      at = next;
    }
    expect(gaps).toEqual([1, 2, 4, 8, 16, 32, 60, 60]);
    expect(await runSweep(rt, at)).toEqual({ ...ZERO, failed: 1 });
    expect(await onlyDelivery(rt)).toMatchObject({
      status: "failed",
      attempts: 9,
    });
    expect(mailer.sent).toHaveLength(0);
  });

  it("fails a PermanentMailError at once", async () => {
    const mailer = memoryMailer({ fail: "permanent" });
    const { auth, rt } = await setup({ mailer });
    const { ticket } = await webTicket(auth, rt);
    await agentPost(rt, ticket);
    expect(await runSweep(rt, later(DELAY + 1_000))).toEqual({
      ...ZERO,
      failed: 1,
    });
    expect(await onlyDelivery(rt)).toMatchObject({
      status: "failed",
      attempts: 1,
      detail: "memoryMailer: permanent failure",
    });
  });

  it("reclaims a sending row whose lease ran out and sends it", async () => {
    const { auth, rt, mailer } = await setup({ leaseMs: 5 * MINUTE });
    const { ticket } = await webTicket(auth, rt);
    await agentPost(rt, ticket);
    const row = await onlyDelivery(rt);
    const now = later(DELAY + 10 * MINUTE);

    // a live lease is left alone
    await setDelivery(rt, row.id, {
      status: "sending",
      attempts: 1,
      claimedAt: new Date(now.getTime() - 4 * MINUTE),
    });
    expect(await runSweep(rt, now)).toEqual(ZERO);
    expect((await onlyDelivery(rt)).status).toBe("sending");

    // a stale one goes back to pending and is sent in the same sweep
    await setDelivery(rt, row.id, {
      claimedAt: new Date(now.getTime() - 6 * MINUTE),
    });
    expect(await runSweep(rt, now)).toEqual({ ...ZERO, sent: 1 });
    expect(await onlyDelivery(rt)).toMatchObject({
      status: "sent",
      attempts: 2,
    });
    expect((mailer as MemoryMailer).sent).toHaveLength(1);
  });

  it("fails a stale sending row that has used up maxAttempts", async () => {
    const { auth, rt, mailer } = await setup({ maxAttempts: 3 });
    const { ticket } = await webTicket(auth, rt);
    await agentPost(rt, ticket);
    const row = await onlyDelivery(rt);
    const now = later(DELAY + 60 * MINUTE);
    await setDelivery(rt, row.id, {
      status: "sending",
      attempts: 3,
      claimedAt: new Date(now.getTime() - 30 * MINUTE),
    });
    expect(await runSweep(rt, now)).toEqual(ZERO);
    expect(await onlyDelivery(rt)).toMatchObject({
      status: "failed",
      detail: "send did not finish",
    });
    expect((mailer as MemoryMailer).sent).toHaveLength(0);
  });

  it("sends a row once when two sweeps race for it", async () => {
    const { auth, rt, mailer } = await setup();
    const { ticket } = await webTicket(auth, rt);
    await agentPost(rt, ticket);
    const now = later(DELAY + 1_000);
    const [a, b] = await Promise.all([runSweep(rt, now), runSweep(rt, now)]);
    expect(a.sent + b.sent).toBe(1);
    expect((mailer as MemoryMailer).sent).toHaveLength(1);
  });
});

describe("runSweep: batches and counts", () => {
  it("sends at most batchSize and reports hasMore", async () => {
    const { auth, rt, mailer } = await setup({ batchSize: 2 });
    for (let i = 0; i < 3; i++) {
      const { ticket } = await webTicket(auth, rt, {
        email: `user${i}@acme.test`,
      });
      await agentPost(rt, ticket);
    }
    const now = later(DELAY + 1_000);
    expect(await runSweep(rt, now)).toEqual({
      ...ZERO,
      sent: 2,
      hasMore: true,
    });
    expect(await runSweep(rt, now)).toEqual({ ...ZERO, sent: 1 });
    expect((mailer as MemoryMailer).sent).toHaveLength(3);
  });

  it("counts sent, skipped, retrying and failed in one sweep", async () => {
    const { mailer, sent } = routingMailer();
    const { auth, rt } = await setup({ mailer });
    for (const email of ["ok@acme.test", "retry@acme.test", "perm@acme.test"]) {
      const { ticket } = await webTicket(auth, rt, { email });
      await agentPost(rt, ticket);
    }
    const { ticket: unverified } = await webTicket(auth, rt, {
      email: "new@acme.test",
      verified: false,
    });
    await agentPost(rt, unverified);
    expect(await runSweep(rt, later(DELAY + 1_000))).toEqual({
      ...ZERO,
      sent: 1,
      skipped: 1,
      retrying: 1,
      failed: 1,
    });
    expect(sent.map((m) => m.to)).toEqual(["ok@acme.test"]);
  });
});

describe("runSweep: auto-close", () => {
  it("closes solved tickets past autoCloseAfter as the system", async () => {
    const { auth, rt } = await setup({ autoCloseAfter: 7 * DAY });
    const now = new Date();
    const old = await insertTicket(auth, {
      status: "solved",
      solvedAt: new Date(now.getTime() - 8 * DAY),
    });
    const fresh = await insertTicket(auth, {
      status: "solved",
      solvedAt: new Date(now.getTime() - 6 * DAY),
    });
    const open = await insertTicket(auth, { status: "open" });

    expect(await runSweep(rt, now)).toEqual({ ...ZERO, closed: 1 });
    const closed = await reloadTicket(rt, old.id);
    expect(closed.status).toBe("closed");
    expect(new Date(closed.solvedAt as Date).getTime()).toBe(
      now.getTime() - 8 * DAY,
    );
    expect((await reloadTicket(rt, fresh.id)).status).toBe("solved");
    expect((await reloadTicket(rt, open.id)).status).toBe("open");

    const events = await rt.adapter.findMany<SupportMessageRow>({
      model: "supportMessage",
      where: [{ field: "ticketId", value: old.id }],
      limit: 10,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "event",
      authorType: "system",
      data: { type: "status", from: "solved", to: "closed" },
    });
    expect(await runSweep(rt, now)).toEqual(ZERO);
  });

  it("auto-closes without a mailer and reports hasMore past batchSize", async () => {
    const { auth, rt } = await setup({ mailer: null, batchSize: 1 });
    const now = new Date();
    for (let i = 0; i < 2; i++) {
      await insertTicket(auth, {
        status: "solved",
        solvedAt: new Date(now.getTime() - 30 * DAY),
      });
    }
    expect(await runSweep(rt, now)).toEqual({
      ...ZERO,
      closed: 1,
      hasMore: true,
    });
    expect(await runSweep(rt, now)).toEqual({ ...ZERO, closed: 1 });
  });
});

describe("processSupportDeliveries", () => {
  it("is server-only and returns the sweep result", async () => {
    const { auth, rt, mailer } = await setup({
      email: { ...EMAIL, replyDelay: 0 },
    });
    const { ticket } = await webTicket(auth, rt);
    await agentPost(rt, ticket);
    const result = await auth.api.processSupportDeliveries();
    expect(result).toEqual({ ...ZERO, sent: 1 });
    expect((mailer as MemoryMailer).sent).toHaveLength(1);

    const response = await auth.handler(
      new Request("http://localhost:3000/api/auth/process-support-deliveries", {
        method: "POST",
      }),
    );
    expect(response.status).toBe(404);
  });

  it("is registered without a mailer", async () => {
    const { auth } = await setup({ mailer: null });
    expect(await auth.api.processSupportDeliveries()).toEqual(ZERO);
  });
});
