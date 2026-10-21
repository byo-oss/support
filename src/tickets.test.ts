import type { ByoEvent } from "@byo-oss/core";
import { describe, expect, it, vi } from "vitest";
import { authRuntime, type SupportRuntime } from "./adapter";
import { SUPPORT_ERROR_CODES } from "./error-codes";
import type {
  SupportMessageRow,
  SupportTicketRow,
  SupportTicketTagRow,
  TicketStatus,
} from "./schema";
import {
  type AdapterCall,
  createTestAuth,
  insertMessage,
  insertTag,
  insertTicket,
} from "./test-utils";
import {
  addMessage,
  applyStatus,
  createTicket,
  markSeen,
  normalizeTags,
  setTags,
} from "./tickets";
import { isReplyToken } from "./token";

const REQUESTER = "user_requester";
const TEAMMATE = "user_teammate";
const AGENT = "user_agent";
const OLD = new Date("2020-01-01T00:00:00.000Z");

async function setup(before?: (call: AdapterCall) => void | Promise<void>) {
  const events: ByoEvent[] = [];
  const auth = createTestAuth(
    { onEvent: (event) => void events.push(event) },
    { adapter: { before } },
  );
  const rt = await authRuntime(auth, "tickets.test");
  return { auth, rt, events };
}

/** An open web ticket from `REQUESTER`, dated long ago, with no messages. */
const seedTicket = (
  auth: Awaited<ReturnType<typeof setup>>["auth"],
  overrides: Partial<Omit<SupportTicketRow, "id">> = {},
) =>
  insertTicket(auth, {
    userId: REQUESTER,
    organizationId: "org_1",
    lastMessageAt: OLD,
    createdAt: OLD,
    updatedAt: OLD,
    ...overrides,
  });

async function messagesOf(
  rt: SupportRuntime,
  ticketId: string,
): Promise<SupportMessageRow[]> {
  return rt.adapter.findMany<SupportMessageRow>({
    model: "supportMessage",
    where: [{ field: "ticketId", value: ticketId }],
    limit: 100,
  });
}

async function reload(
  rt: SupportRuntime,
  ticketId: string,
): Promise<SupportTicketRow> {
  const row = await rt.adapter.findOne<SupportTicketRow>({
    model: "supportTicket",
    where: [{ field: "id", value: ticketId }],
  });
  if (!row) throw new Error("ticket vanished");
  return row;
}

async function allTickets(rt: SupportRuntime): Promise<SupportTicketRow[]> {
  return rt.adapter.findMany<SupportTicketRow>({
    model: "supportTicket",
    limit: 100,
  });
}

const types = (events: ByoEvent[]) => events.map((e) => e.type);

describe("createTicket", () => {
  it("creates a web ticket with number, token, first message and seen mark", async () => {
    const { rt, events } = await setup();
    const first = await createTicket(rt, {
      subject: "Cannot log in",
      body: "Please help",
      channel: "web",
      userId: REQUESTER,
      organizationId: "org_1",
      visibility: "organization",
      verified: true,
      actorId: REQUESTER,
    });
    const second = await createTicket(rt, {
      subject: "Another",
      body: "More",
      channel: "web",
      userId: REQUESTER,
      verified: true,
      actorId: REQUESTER,
    });

    expect(first.ticket).toMatchObject({
      number: 1,
      subject: "Cannot log in",
      status: "open",
      channel: "web",
      userId: REQUESTER,
      organizationId: "org_1",
      visibility: "organization",
      verified: true,
      requesterEmail: null,
      agentSeenAt: null,
      solvedAt: null,
    });
    expect(second.ticket.number).toBe(2);
    expect(second.ticket.visibility).toBe("private");
    expect(second.ticket.organizationId).toBeNull();
    expect(isReplyToken(first.ticket.replyToken)).toBe(true);
    expect(first.ticket.replyToken).not.toBe(second.ticket.replyToken);
    expect(first.ticket.requesterSeenAt).toEqual(first.ticket.createdAt);
    expect(first.ticket.lastMessageAt).toEqual(first.ticket.createdAt);
    expect(first.ticket.updatedAt).toEqual(first.ticket.createdAt);

    expect(first.message).toMatchObject({
      ticketId: first.ticket.id,
      kind: "reply",
      authorType: "customer",
      userId: REQUESTER,
      body: "Please help",
      channel: "web",
      verified: true,
    });
    expect(await messagesOf(rt, first.ticket.id)).toHaveLength(1);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "support.ticket.created",
      subject: { type: "supportTicket", id: first.ticket.id },
      organizationId: "org_1",
      actorId: REQUESTER,
      userId: REQUESTER,
      data: {
        ticketId: first.ticket.id,
        number: 1,
        channel: "web",
        visibility: "organization",
      },
    });
    expect(JSON.stringify(events[0]?.data)).not.toContain("Please help");
    expect(JSON.stringify(events[0]?.data)).not.toContain("Cannot log in");
    expect(events[1]).not.toHaveProperty("organizationId");
  });

  it("leaves requesterSeenAt null for an email ticket and stores an account-less requester lowercased", async () => {
    const { rt, events } = await setup();
    const { ticket, message } = await createTicket(rt, {
      subject: "Via mail",
      body: "Hello from mail",
      channel: "email",
      requesterEmail: "  Jane.Doe@Example.COM ",
      requesterName: "Jane",
      verified: false,
      emailMessageId: "<abc@mail.example>",
      actorId: null,
    });
    expect(ticket).toMatchObject({
      channel: "email",
      userId: null,
      requesterEmail: "jane.doe@example.com",
      requesterName: "Jane",
      verified: false,
      organizationId: null,
      visibility: "private",
      requesterSeenAt: null,
    });
    expect(message).toMatchObject({
      authorType: "customer",
      userId: null,
      authorEmail: "jane.doe@example.com",
      authorName: "Jane",
      channel: "email",
      verified: false,
      emailMessageId: "<abc@mail.example>",
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.actorId).toBeNull();
    expect(events[0]).not.toHaveProperty("userId");
  });

  it("an email ticket created for an account keeps requesterSeenAt null", async () => {
    const { rt } = await setup();
    const { ticket } = await createTicket(rt, {
      subject: "s",
      body: "b",
      channel: "email",
      userId: REQUESTER,
      verified: true,
      actorId: REQUESTER,
    });
    expect(ticket.requesterSeenAt).toBeNull();
    expect(ticket.requesterEmail).toBeNull();
  });

  it("rolls back when the first message insert throws, rethrows the original error and emits nothing", async () => {
    const boom = new Error("unique constraint: emailMessageId");
    const { rt, events } = await setup((call) => {
      if (call.method === "create" && call.model === "supportMessage")
        throw boom;
    });
    await expect(
      createTicket(rt, {
        subject: "s",
        body: "b",
        channel: "email",
        requesterEmail: "a@b.test",
        verified: true,
        emailMessageId: "<dup@x>",
        actorId: null,
      }),
    ).rejects.toBe(boom);
    expect(await allTickets(rt)).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it("still rethrows the original error when removing the ticket also fails", async () => {
    const boom = new Error("insert failed");
    const { rt } = await setup((call) => {
      if (call.method === "create" && call.model === "supportMessage")
        throw boom;
      if (call.method === "delete" && call.model === "supportTicket")
        throw new Error("delete failed");
    });
    const error = vi.fn();
    const quiet = {
      ...rt,
      context: { ...rt.context, logger: { ...rt.context.logger, error } },
    } as SupportRuntime;
    await expect(
      createTicket(quiet, {
        subject: "s",
        body: "b",
        channel: "web",
        userId: REQUESTER,
        verified: true,
        actorId: REQUESTER,
      }),
    ).rejects.toBe(boom);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("allocates a new number after a number conflict on the ticket insert", async () => {
    let conflicts = 0;
    let armed = false;
    const { rt, auth, events } = await setup((call) => {
      if (
        armed &&
        call.method === "create" &&
        call.model === "supportTicket" &&
        (call.args.data as { number: number }).number === 1
      ) {
        conflicts++;
        throw new Error("unique constraint: number");
      }
    });
    // number 1 is already taken (the memory adapter has no unique index)
    await insertTicket(auth, { number: 1 });
    armed = true;
    const { ticket } = await createTicket(rt, {
      subject: "s",
      body: "b",
      channel: "web",
      userId: REQUESTER,
      verified: true,
      actorId: REQUESTER,
    });
    expect(conflicts).toBe(1);
    expect(ticket.number).toBe(2);
    expect(events).toHaveLength(1);
  });

  it("gives up after three number conflicts", async () => {
    let attempts = 0;
    let armed = false;
    const { rt, auth, events } = await setup((call) => {
      if (armed && call.method === "create" && call.model === "supportTicket") {
        attempts++;
        throw new Error("unique constraint: number");
      }
    });
    for (const number of [1, 2, 3, 4]) await insertTicket(auth, { number });
    armed = true;
    await expect(
      createTicket(rt, {
        subject: "s",
        body: "b",
        channel: "web",
        userId: REQUESTER,
        verified: true,
        actorId: REQUESTER,
      }),
    ).rejects.toThrow("unique constraint");
    expect(attempts).toBe(3);
    expect(events).toHaveLength(0);
  });

  it("rethrows a ticket insert error that is not a number conflict at once", async () => {
    let attempts = 0;
    const { rt, events } = await setup((call) => {
      if (call.method === "create" && call.model === "supportTicket") {
        attempts++;
        throw new Error("database down");
      }
    });
    await expect(
      createTicket(rt, {
        subject: "s",
        body: "b",
        channel: "web",
        userId: REQUESTER,
        verified: true,
        actorId: REQUESTER,
      }),
    ).rejects.toThrow("database down");
    expect(attempts).toBe(1);
    expect(events).toHaveLength(0);
  });
});

describe("status transitions", () => {
  const ALL: TicketStatus[] = ["open", "pending", "solved", "closed"];

  it("create -> open", async () => {
    const { rt } = await setup();
    const { ticket } = await createTicket(rt, {
      subject: "s",
      body: "b",
      channel: "web",
      userId: REQUESTER,
      verified: true,
      actorId: REQUESTER,
    });
    expect(ticket.status).toBe("open");
  });

  it.each([
    ["open", "open", false],
    ["pending", "open", true],
    ["solved", "open", true],
  ] as const)("customer reply on %s -> %s", async (from, to, changes) => {
    const { auth, rt, events } = await setup();
    const ticket = await seedTicket(auth, {
      status: from,
      solvedAt: from === "solved" ? OLD : null,
    });
    const result = await addMessage(rt, {
      ticket,
      kind: "reply",
      authorType: "customer",
      userId: REQUESTER,
      body: "ping",
      channel: "web",
      verified: true,
      actorId: REQUESTER,
    });
    expect(result.ticket.status).toBe(to);
    expect((await reload(rt, ticket.id)).status).toBe(to);
    expect((await reload(rt, ticket.id)).solvedAt ?? null).toBeNull();
    const rows = await messagesOf(rt, ticket.id);
    const statusRows = rows.filter((m) => m.kind === "event");
    expect(statusRows).toHaveLength(changes ? 1 : 0);
    if (changes) {
      expect(statusRows[0]).toMatchObject({
        authorType: "customer",
        userId: REQUESTER,
        data: { type: "status", from, to },
      });
    }
    expect(
      types(events).filter((t) => t === "support.ticket.status_changed"),
    ).toHaveLength(changes ? 1 : 0);
  });

  it.each(["open", "pending", "solved"] as const)(
    "agent reply on %s -> pending by default",
    async (from) => {
      const { auth, rt } = await setup();
      const ticket = await seedTicket(auth, { status: from });
      const result = await addMessage(rt, {
        ticket,
        kind: "reply",
        authorType: "agent",
        userId: AGENT,
        body: "we are on it",
        channel: "web",
        verified: true,
        actorId: AGENT,
      });
      expect(result.ticket.status).toBe("pending");
      expect((await reload(rt, ticket.id)).status).toBe("pending");
    },
  );

  it("an agent reply on a pending ticket changes no status and writes no status event", async () => {
    const { auth, rt, events } = await setup();
    const ticket = await seedTicket(auth, { status: "pending" });
    await addMessage(rt, {
      ticket,
      kind: "reply",
      authorType: "agent",
      userId: AGENT,
      body: "more",
      channel: "web",
      verified: true,
      actorId: AGENT,
    });
    expect(
      (await messagesOf(rt, ticket.id)).filter((m) => m.kind === "event"),
    ).toHaveLength(0);
    expect(types(events)).toEqual(["support.agent.replied"]);
  });

  for (const from of ["open", "pending", "solved"] as const) {
    for (const to of ALL.filter((s) => s !== from)) {
      it(`an agent reply sets any status given: ${from} -> ${to}`, async () => {
        const { auth, rt, events } = await setup();
        const ticket = await seedTicket(auth, {
          status: from,
          solvedAt: from === "solved" ? OLD : null,
        });
        const result = await addMessage(rt, {
          ticket,
          kind: "reply",
          authorType: "agent",
          userId: AGENT,
          body: "b",
          channel: "web",
          verified: true,
          status: to,
          actorId: AGENT,
        });
        expect(result.ticket.status).toBe(to);
        const stored = await reload(rt, ticket.id);
        expect(stored.status).toBe(to);
        if (to === "solved") expect(stored.solvedAt).toBeInstanceOf(Date);
        else if (to === "closed") {
          expect(stored.solvedAt ?? null).toEqual(
            from === "solved" ? OLD : null,
          );
        } else expect(stored.solvedAt ?? null).toBeNull();
        const statusEvents = events.filter(
          (e) => e.type === "support.ticket.status_changed",
        );
        expect(statusEvents).toHaveLength(1);
        expect(statusEvents[0]?.data).toEqual({
          ticketId: ticket.id,
          from,
          to,
          visibility: ticket.visibility,
        });
      });
    }
  }

  it("agent reply with the status it already has writes no status row or event", async () => {
    const { auth, rt, events } = await setup();
    const ticket = await seedTicket(auth, { status: "open" });
    const result = await addMessage(rt, {
      ticket,
      kind: "reply",
      authorType: "agent",
      userId: AGENT,
      body: "b",
      channel: "web",
      verified: true,
      status: "open",
      actorId: AGENT,
    });
    expect(result.ticket.status).toBe("open");
    expect(types(events)).toEqual(["support.agent.replied"]);
    expect(events[0]?.data).toMatchObject({ status: "open" });
    expect(
      (await messagesOf(rt, ticket.id)).filter((m) => m.kind === "event"),
    ).toHaveLength(0);
  });

  it("a note keeps the status when none is given", async () => {
    const { auth, rt, events } = await setup();
    const ticket = await seedTicket(auth, { status: "open" });
    const { ticket: after } = await addMessage(rt, {
      ticket,
      kind: "note",
      authorType: "agent",
      userId: AGENT,
      body: "internal",
      channel: "web",
      verified: true,
      actorId: AGENT,
    });
    expect(after.status).toBe("open");
    expect(types(events)).toEqual(["support.note.added"]);
  });

  it("a note with a status applies it once: one event row and one status_changed event", async () => {
    const { auth, rt, events } = await setup();
    const ticket = await seedTicket(auth, { status: "open" });
    const { ticket: after } = await addMessage(rt, {
      ticket,
      kind: "note",
      authorType: "agent",
      userId: AGENT,
      body: "internal",
      channel: "web",
      verified: true,
      status: "solved",
      actorId: AGENT,
    });
    expect(after.status).toBe("solved");
    expect(after.solvedAt).toBeInstanceOf(Date);
    const rows = await messagesOf(rt, ticket.id);
    expect(rows.filter((m) => m.kind === "event")).toHaveLength(1);
    expect(rows.filter((m) => m.kind === "note")).toHaveLength(1);
    expect(
      events.filter((e) => e.type === "support.ticket.status_changed"),
    ).toHaveLength(1);
    expect(types(events)).toEqual([
      "support.ticket.status_changed",
      "support.note.added",
    ]);
  });

  it.each(["reply", "note"] as const)(
    "a %s on a closed ticket is TICKET_CLOSED and writes nothing",
    async (kind) => {
      const { auth, rt, events } = await setup();
      const ticket = await seedTicket(auth, { status: "closed" });
      const authorType = kind === "reply" ? "customer" : "agent";
      await expect(
        addMessage(rt, {
          ticket,
          kind,
          authorType,
          userId: kind === "reply" ? REQUESTER : AGENT,
          body: "late",
          channel: "web",
          verified: true,
          status: "open",
          actorId: REQUESTER,
        }),
      ).rejects.toMatchObject({
        status: "BAD_REQUEST",
        body: { code: "TICKET_CLOSED" },
      });
      expect(await messagesOf(rt, ticket.id)).toHaveLength(0);
      expect(await reload(rt, ticket.id)).toEqual(ticket);
      expect(events).toHaveLength(0);
    },
  );

  it("an agent reply on a closed ticket is refused too", async () => {
    const { auth, rt } = await setup();
    const ticket = await seedTicket(auth, { status: "closed" });
    await expect(
      addMessage(rt, {
        ticket,
        kind: "reply",
        authorType: "agent",
        userId: AGENT,
        body: "late",
        channel: "web",
        verified: true,
        actorId: AGENT,
      }),
    ).rejects.toMatchObject({ body: { code: "TICKET_CLOSED" } });
  });

  it("event rows never transition, bump or emit", async () => {
    const { auth, rt, events } = await setup();
    const ticket = await seedTicket(auth, { status: "solved", solvedAt: OLD });
    const result = await addMessage(rt, {
      ticket,
      kind: "event",
      authorType: "system",
      body: "",
      data: { type: "followup_of", from: "t0" },
      channel: "email",
      verified: true,
      actorId: null,
    });
    expect(result.message).toMatchObject({
      kind: "event",
      data: { type: "followup_of", from: "t0" },
    });
    expect(await reload(rt, ticket.id)).toEqual(ticket);
    expect(events).toHaveLength(0);
  });

  describe("applyStatus", () => {
    it("solve sets solvedAt, reopen and pending clear it, closed keeps it", async () => {
      const { auth, rt } = await setup();
      let ticket = await seedTicket(auth, { status: "open" });
      ticket = await applyStatus(rt, {
        ticket,
        to: "solved",
        actorId: REQUESTER,
        authorType: "customer",
      });
      expect(ticket.status).toBe("solved");
      const solvedAt = ticket.solvedAt;
      expect(solvedAt).toBeInstanceOf(Date);
      expect((await reload(rt, ticket.id)).solvedAt).toEqual(solvedAt);
      expect(ticket.updatedAt.getTime()).toBeGreaterThan(OLD.getTime());

      ticket = await applyStatus(rt, {
        ticket,
        to: "closed",
        actorId: null,
        authorType: "system",
      });
      expect(ticket.status).toBe("closed");
      expect((await reload(rt, ticket.id)).solvedAt).toEqual(solvedAt);

      ticket = await applyStatus(rt, {
        ticket,
        to: "open",
        actorId: AGENT,
        authorType: "agent",
      });
      expect((await reload(rt, ticket.id)).solvedAt ?? null).toBeNull();

      ticket = await applyStatus(rt, {
        ticket,
        to: "solved",
        actorId: AGENT,
        authorType: "agent",
      });
      ticket = await applyStatus(rt, {
        ticket,
        to: "pending",
        actorId: AGENT,
        authorType: "agent",
      });
      expect((await reload(rt, ticket.id)).solvedAt ?? null).toBeNull();
    });

    it("writes a status event row with from/to and the given author type", async () => {
      const { auth, rt, events } = await setup();
      const ticket = await seedTicket(auth, { status: "solved" });
      await applyStatus(rt, {
        ticket,
        to: "closed",
        actorId: null,
        authorType: "system",
      });
      const rows = await messagesOf(rt, ticket.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: "event",
        authorType: "system",
        userId: null,
        data: { type: "status", from: "solved", to: "closed" },
      });
      expect(events).toHaveLength(1);
    });

    it("same status is a no-op: no write, no event row, no event", async () => {
      const { auth, rt, events } = await setup();
      const ticket = await seedTicket(auth, { status: "pending" });
      const result = await applyStatus(rt, {
        ticket,
        to: "pending",
        actorId: AGENT,
        authorType: "agent",
      });
      expect(result).toBe(ticket);
      expect(await reload(rt, ticket.id)).toEqual(ticket);
      expect(await messagesOf(rt, ticket.id)).toHaveLength(0);
      expect(events).toHaveLength(0);
    });

    it("emits status_changed with subject, organization, actor and requester, without a body", async () => {
      const { auth, rt, events } = await setup();
      const ticket = await seedTicket(auth, { status: "open" });
      await applyStatus(rt, {
        ticket,
        to: "solved",
        actorId: REQUESTER,
        authorType: "customer",
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "support.ticket.status_changed",
        subject: { type: "supportTicket", id: ticket.id },
        organizationId: "org_1",
        actorId: REQUESTER,
        userId: REQUESTER,
        data: { ticketId: ticket.id, from: "open", to: "solved" },
      });
    });
  });
});

describe("addMessage", () => {
  const reply = (ticket: SupportTicketRow, extra = {}) => ({
    ticket,
    kind: "reply" as const,
    authorType: "customer" as const,
    userId: REQUESTER,
    body: "secret body text",
    channel: "web" as const,
    verified: true,
    actorId: REQUESTER,
    ...extra,
  });

  it("a duplicate emailMessageId throws before any ticket update or event", async () => {
    // the memory adapter has no unique index, so the lane simulates one
    const known = new Set<string>();
    const { auth, rt, events } = await setup((call) => {
      const id = (call.args.data as { emailMessageId?: string } | undefined)
        ?.emailMessageId;
      if (call.method === "create" && call.model === "supportMessage" && id) {
        if (known.has(id)) throw new Error("unique constraint: emailMessageId");
        known.add(id);
      }
    });
    const ticket = await seedTicket(auth, { status: "solved", solvedAt: OLD });
    await insertMessage(auth, {
      ticketId: ticket.id,
      emailMessageId: "<dup@mail.test>",
    });
    known.add("<dup@mail.test>");

    await expect(
      addMessage(
        rt,
        reply(ticket, { channel: "email", emailMessageId: "<dup@mail.test>" }),
      ),
    ).rejects.toThrow("unique constraint");
    expect(await reload(rt, ticket.id)).toEqual(ticket);
    expect(await messagesOf(rt, ticket.id)).toHaveLength(1);
    expect(events).toHaveLength(0);

    // an agent reply fails the same way, and mentions emit nothing either
    await expect(
      addMessage(
        rt,
        reply(ticket, {
          authorType: "agent",
          userId: AGENT,
          emailMessageId: "<dup@mail.test>",
          mentions: [TEAMMATE],
          status: "closed",
          actorId: AGENT,
        }),
      ),
    ).rejects.toThrow("unique constraint");
    expect(await reload(rt, ticket.id)).toEqual(ticket);
    expect(await messagesOf(rt, ticket.id)).toHaveLength(1);
    expect(events).toHaveLength(0);
  });

  it("stores the message fields, lowercases an account-less sender and keeps mentions for agents only", async () => {
    const { auth, rt } = await setup();
    const ticket = await seedTicket(auth);
    const { message } = await addMessage(rt, {
      ticket,
      kind: "reply",
      authorType: "customer",
      authorEmail: "  Some.One@Example.COM ",
      authorName: "Some One",
      body: "hi",
      mentions: [AGENT],
      channel: "email",
      verified: false,
      emailMessageId: "<id1@x>",
      actorId: null,
    });
    expect(message).toMatchObject({
      ticketId: ticket.id,
      kind: "reply",
      authorType: "customer",
      userId: null,
      authorEmail: "some.one@example.com",
      authorName: "Some One",
      body: "hi",
      mentions: null,
      channel: "email",
      verified: false,
      emailMessageId: "<id1@x>",
    });

    const agent = await addMessage(rt, {
      ticket,
      kind: "note",
      authorType: "agent",
      userId: AGENT,
      body: "cc",
      mentions: [TEAMMATE, TEAMMATE, REQUESTER],
      channel: "web",
      verified: true,
      actorId: AGENT,
    });
    expect(agent.message.mentions).toEqual([TEAMMATE, REQUESTER]);
    expect(agent.message.data ?? null).toBeNull();
  });

  describe("requesterSeenAt", () => {
    it("a web reply by the requester sets it to the message time", async () => {
      const { auth, rt } = await setup();
      const ticket = await seedTicket(auth, { requesterSeenAt: null });
      const { message, ticket: after } = await addMessage(rt, reply(ticket));
      expect(after.requesterSeenAt).toEqual(message.createdAt);
      expect((await reload(rt, ticket.id)).requesterSeenAt).toEqual(
        message.createdAt,
      );
    });

    it("an email reply by the requester does not set it", async () => {
      const { auth, rt } = await setup();
      const ticket = await seedTicket(auth, { requesterSeenAt: null });
      const { ticket: after } = await addMessage(
        rt,
        reply(ticket, { channel: "email" }),
      );
      expect(after.requesterSeenAt ?? null).toBeNull();
      expect((await reload(rt, ticket.id)).requesterSeenAt ?? null).toBeNull();
    });

    it("a teammate's web reply does not set it", async () => {
      const { auth, rt } = await setup();
      const ticket = await seedTicket(auth, {
        requesterSeenAt: null,
        visibility: "organization",
      });
      const { ticket: after } = await addMessage(
        rt,
        reply(ticket, { userId: TEAMMATE, actorId: TEAMMATE }),
      );
      expect(after.requesterSeenAt ?? null).toBeNull();
      expect((await reload(rt, ticket.id)).requesterSeenAt ?? null).toBeNull();
    });

    it("an agent reply or note does not set it and sets agentSeenAt", async () => {
      const { auth, rt } = await setup();
      const ticket = await seedTicket(auth, { requesterSeenAt: null });
      for (const kind of ["reply", "note"] as const) {
        const { message } = await addMessage(
          rt,
          reply(ticket, {
            kind,
            authorType: "agent",
            userId: AGENT,
            actorId: AGENT,
          }),
        );
        const stored = await reload(rt, ticket.id);
        expect(stored.requesterSeenAt ?? null).toBeNull();
        expect(stored.agentSeenAt).toEqual(message.createdAt);
      }
    });

    it("a customer reply leaves agentSeenAt alone", async () => {
      const { auth, rt } = await setup();
      const ticket = await seedTicket(auth, { agentSeenAt: OLD });
      await addMessage(rt, reply(ticket));
      expect((await reload(rt, ticket.id)).agentSeenAt).toEqual(OLD);
    });
  });

  describe("lastMessageAt", () => {
    it("is bumped by customer and agent replies only", async () => {
      const { auth, rt } = await setup();
      const ticket = await seedTicket(auth);

      const note = await addMessage(
        rt,
        reply(ticket, { kind: "note", authorType: "agent", userId: AGENT }),
      );
      expect(note.ticket.lastMessageAt).toEqual(OLD);
      expect((await reload(rt, ticket.id)).lastMessageAt).toEqual(OLD);
      expect((await reload(rt, ticket.id)).updatedAt).toEqual(OLD);

      await addMessage(rt, {
        ticket,
        kind: "event",
        authorType: "system",
        body: "",
        data: { type: "priority", from: null, to: "high" },
        channel: "web",
        verified: true,
        actorId: AGENT,
      });
      expect((await reload(rt, ticket.id)).lastMessageAt).toEqual(OLD);

      const noted = await applyStatus(rt, {
        ticket,
        to: "solved",
        actorId: AGENT,
        authorType: "agent",
      });
      expect(noted.lastMessageAt).toEqual(OLD);
      expect((await reload(rt, ticket.id)).lastMessageAt).toEqual(OLD);

      const customer = await addMessage(rt, reply(noted));
      expect(customer.ticket.lastMessageAt.getTime()).toBeGreaterThan(
        OLD.getTime(),
      );
      expect(customer.ticket.updatedAt.getTime()).toBeGreaterThan(
        OLD.getTime(),
      );
      expect((await reload(rt, ticket.id)).lastMessageAt).toEqual(
        customer.message.createdAt,
      );

      await reload(rt, ticket.id);
      const agent = await addMessage(
        rt,
        reply(customer.ticket, { authorType: "agent", userId: AGENT }),
      );
      expect((await reload(rt, ticket.id)).lastMessageAt).toEqual(
        agent.message.createdAt,
      );
    });

    it("a note with a status bumps updatedAt (status change) but not lastMessageAt", async () => {
      const { auth, rt } = await setup();
      const ticket = await seedTicket(auth);
      await addMessage(
        rt,
        reply(ticket, {
          kind: "note",
          authorType: "agent",
          userId: AGENT,
          status: "pending",
        }),
      );
      const stored = await reload(rt, ticket.id);
      expect(stored.lastMessageAt).toEqual(OLD);
      expect(stored.updatedAt.getTime()).toBeGreaterThan(OLD.getTime());
    });
  });

  describe("events", () => {
    it("customer reply: support.customer.replied with ids and channel only", async () => {
      const { auth, rt, events } = await setup();
      const ticket = await seedTicket(auth);
      const { message } = await addMessage(rt, reply(ticket));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "support.customer.replied",
        subject: { type: "supportTicket", id: ticket.id },
        organizationId: "org_1",
        actorId: REQUESTER,
        userId: REQUESTER,
        data: { ticketId: ticket.id, messageId: message.id, channel: "web" },
      });
      expect(JSON.stringify(events[0])).not.toContain("secret body text");
    });

    it("a teammate's reply carries the requester as userId and the teammate as actor", async () => {
      const { auth, rt, events } = await setup();
      const ticket = await seedTicket(auth, { visibility: "organization" });
      await addMessage(
        rt,
        reply(ticket, { userId: TEAMMATE, actorId: TEAMMATE }),
      );
      expect(events[0]).toMatchObject({
        type: "support.customer.replied",
        actorId: TEAMMATE,
        userId: REQUESTER,
      });
    });

    it("agent reply: support.agent.replied carries the status after the reply", async () => {
      const { auth, rt, events } = await setup();
      const ticket = await seedTicket(auth);
      const { message } = await addMessage(
        rt,
        reply(ticket, {
          authorType: "agent",
          userId: AGENT,
          actorId: AGENT,
          status: "solved",
        }),
      );
      expect(types(events)).toEqual([
        "support.ticket.status_changed",
        "support.agent.replied",
      ]);
      expect(events[1]).toMatchObject({
        organizationId: "org_1",
        actorId: AGENT,
        userId: REQUESTER,
        data: { ticketId: ticket.id, messageId: message.id, status: "solved" },
      });
      expect(JSON.stringify(events)).not.toContain("secret body text");
    });

    it("note: support.note.added has no userId, and one support.agent.mentioned per mention", async () => {
      const { auth, rt, events } = await setup();
      const ticket = await seedTicket(auth);
      const { message } = await addMessage(
        rt,
        reply(ticket, {
          kind: "note",
          authorType: "agent",
          userId: AGENT,
          actorId: AGENT,
          mentions: [TEAMMATE, REQUESTER, TEAMMATE],
        }),
      );
      expect(types(events)).toEqual([
        "support.note.added",
        "support.agent.mentioned",
        "support.agent.mentioned",
      ]);
      expect(events[0]).not.toHaveProperty("userId");
      expect(events[0]).toMatchObject({
        organizationId: "org_1",
        actorId: AGENT,
        data: { ticketId: ticket.id, messageId: message.id },
      });
      expect(events[1]).toMatchObject({
        userId: TEAMMATE,
        actorId: AGENT,
        subject: { type: "supportTicket", id: ticket.id },
        data: { ticketId: ticket.id, messageId: message.id, kind: "note" },
      });
      expect(events[2]?.userId).toBe(REQUESTER);
      expect(JSON.stringify(events)).not.toContain("secret body text");
    });

    it("mentions on an agent reply carry kind reply", async () => {
      const { auth, rt, events } = await setup();
      const ticket = await seedTicket(auth);
      await addMessage(
        rt,
        reply(ticket, {
          authorType: "agent",
          userId: AGENT,
          actorId: AGENT,
          mentions: [TEAMMATE],
        }),
      );
      expect(types(events)).toEqual([
        "support.ticket.status_changed",
        "support.agent.replied",
        "support.agent.mentioned",
      ]);
      expect(events[2]?.data).toMatchObject({ kind: "reply" });
    });

    it("an account-less requester's ticket events have no userId", async () => {
      const { auth, rt, events } = await setup();
      const ticket = await seedTicket(auth, {
        userId: null,
        requesterEmail: "x@y.test",
        channel: "email",
      });
      await addMessage(
        rt,
        reply(ticket, {
          authorType: "agent",
          userId: AGENT,
          actorId: AGENT,
        }),
      );
      for (const event of events) expect(event).not.toHaveProperty("userId");
    });
  });

  it("returns the ticket as it is after the write", async () => {
    const { auth, rt } = await setup();
    const ticket = await seedTicket(auth, { status: "solved", solvedAt: OLD });
    const result = await addMessage(rt, reply(ticket));
    expect(result.ticket).toEqual(await reload(rt, ticket.id));
    expect(result.ticket.status).toBe("open");
    expect(result.ticket.solvedAt ?? null).toBeNull();
  });
});

describe("a throwing onEvent never fails the call", () => {
  it("createTicket, addMessage and applyStatus resolve and log", async () => {
    const onEvent = vi.fn(() => {
      throw new Error("consumer down");
    });
    const auth = createTestAuth({ onEvent });
    const base = await authRuntime(auth, "tickets.test");
    const error = vi.fn();
    const rt = {
      ...base,
      context: { ...base.context, logger: { ...base.context.logger, error } },
    } as SupportRuntime;

    const { ticket } = await createTicket(rt, {
      subject: "s",
      body: "b",
      channel: "web",
      userId: REQUESTER,
      verified: true,
      actorId: REQUESTER,
    });
    const { ticket: after } = await addMessage(rt, {
      ticket,
      kind: "reply",
      authorType: "agent",
      userId: AGENT,
      body: "b",
      mentions: [TEAMMATE],
      channel: "web",
      verified: true,
      actorId: AGENT,
    });
    await applyStatus(rt, {
      ticket: after,
      to: "solved",
      actorId: AGENT,
      authorType: "agent",
    });
    // created, status_changed, replied, mentioned, status_changed
    expect(onEvent).toHaveBeenCalledTimes(5);
    expect(error).toHaveBeenCalledTimes(5);
    expect((await reload(rt, ticket.id)).status).toBe("solved");
  });
});

describe("markSeen", () => {
  it("sets requesterSeenAt or agentSeenAt, default now, and nothing else", async () => {
    const { auth, rt } = await setup();
    const ticket = await seedTicket(auth, {
      requesterSeenAt: null,
      agentSeenAt: null,
    });
    const at = new Date("2024-05-05T10:00:00.000Z");
    await markSeen(rt, { ticketId: ticket.id, side: "requester", at });
    let stored = await reload(rt, ticket.id);
    expect(stored.requesterSeenAt).toEqual(at);
    expect(stored.agentSeenAt ?? null).toBeNull();

    const before = Date.now();
    await markSeen(rt, { ticketId: ticket.id, side: "agent" });
    stored = await reload(rt, ticket.id);
    expect(stored.agentSeenAt?.getTime()).toBeGreaterThanOrEqual(before);
    expect(stored.requesterSeenAt).toEqual(at);
    expect(stored.updatedAt).toEqual(OLD);
    expect(stored.lastMessageAt).toEqual(OLD);
  });
});

describe("tags", () => {
  it("normalizeTags trims, lowercases and dedupes in order", () => {
    expect(normalizeTags([" Billing ", "billing", "VIP_1", "a-b"])).toEqual([
      "billing",
      "vip_1",
      "a-b",
    ]);
    expect(normalizeTags([])).toEqual([]);
    expect(normalizeTags(["x".repeat(50)])).toEqual(["x".repeat(50)]);
  });

  it.each([
    ["empty", ""],
    ["blank", "   "],
    ["too long", "x".repeat(51)],
    ["space inside", "two words"],
    ["dot", "a.b"],
    ["unicode", "café"],
    ["slash", "a/b"],
  ])("normalizeTags refuses a tag that is %s with INVALID_TAG", (_, tag) => {
    let thrown: unknown;
    try {
      normalizeTags(["ok", tag]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      status: "BAD_REQUEST",
      body: {
        code: "INVALID_TAG",
        message: SUPPORT_ERROR_CODES.INVALID_TAG.message,
      },
    });
  });

  const tagsOf = async (rt: SupportRuntime, ticketId: string) =>
    (
      await rt.adapter.findMany<SupportTicketTagRow>({
        model: "supportTicketTag",
        where: [{ field: "ticketId", value: ticketId }],
        limit: 1000,
      })
    ).map((row) => row.tag);

  it("setTags adds missing tags, ignores ones present, removes, and returns the sorted result", async () => {
    const { auth, rt } = await setup();
    const ticket = await seedTicket(auth);
    const other = await seedTicket(auth);
    await insertTag(auth, { ticketId: ticket.id, tag: "bug" });
    await insertTag(auth, { ticketId: other.id, tag: "zzz" });

    expect(
      await setTags(rt, {
        ticketId: ticket.id,
        add: [" Bug ", "Alpha", "alpha"],
      }),
    ).toEqual(["alpha", "bug"]);
    expect((await tagsOf(rt, ticket.id)).sort()).toEqual(["alpha", "bug"]);

    expect(
      await setTags(rt, {
        ticketId: ticket.id,
        add: ["new"],
        remove: ["BUG", "absent"],
      }),
    ).toEqual(["alpha", "new"]);
    expect((await tagsOf(rt, ticket.id)).sort()).toEqual(["alpha", "new"]);
    // other tickets are untouched
    expect(await tagsOf(rt, other.id)).toEqual(["zzz"]);

    expect(await setTags(rt, { ticketId: ticket.id })).toEqual([
      "alpha",
      "new",
    ]);
  });

  it("setTags writes nothing when any tag is invalid", async () => {
    const { auth, rt } = await setup();
    const ticket = await seedTicket(auth);
    await insertTag(auth, { ticketId: ticket.id, tag: "keep" });
    await expect(
      setTags(rt, { ticketId: ticket.id, add: ["fine"], remove: ["bad tag"] }),
    ).rejects.toMatchObject({ body: { code: "INVALID_TAG" } });
    expect(await tagsOf(rt, ticket.id)).toEqual(["keep"]);
  });

  it("setTags removes in chunks of at most 90 and never sends an empty in-list", async () => {
    const calls: AdapterCall[] = [];
    const { auth, rt } = await setup((call) => {
      if (call.method === "deleteMany") calls.push(call);
    });
    const ticket = await seedTicket(auth);
    const names = Array.from({ length: 200 }, (_, i) => `t${i}`);
    await setTags(rt, { ticketId: ticket.id, add: names });
    expect(await tagsOf(rt, ticket.id)).toHaveLength(200);

    const left = await setTags(rt, {
      ticketId: ticket.id,
      remove: names.slice(0, 195),
    });
    expect(left).toEqual(names.slice(195).sort());
    expect(
      calls.map(
        (c) => (c.args.where as { value: string[] }[])[0]?.value.length,
      ),
    ).toEqual([90, 90, 15]);

    // nothing to remove: no delete call at all
    calls.length = 0;
    await setTags(rt, { ticketId: ticket.id, remove: ["unknown"] });
    expect(calls).toHaveLength(0);
  });

  it("a tag in both add and remove ends up removed", async () => {
    const { auth, rt } = await setup();
    const ticket = await seedTicket(auth);
    expect(
      await setTags(rt, {
        ticketId: ticket.id,
        add: ["a", "b"],
        remove: ["b"],
      }),
    ).toEqual(["a"]);
    expect(await tagsOf(rt, ticket.id)).toEqual(["a"]);
  });
});
