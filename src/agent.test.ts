import type { ByoEvent } from "@byo-oss/core";
import { beforeAll, describe, expect, it } from "vitest";
import { authRuntime, type SupportRuntime } from "./adapter";
import { SUPPORT_ERROR_CODES } from "./error-codes";
import type { SupportOptions, SupportStorage } from "./options";
import type { AgentListFilters } from "./queries";
import type {
  SupportMessageRow,
  SupportTicketRow,
  SupportTicketTagRow,
} from "./schema";
import { toCustomerMessage } from "./serialize";
import type { SupportAction } from "./statements";
import {
  createOrganization,
  createTestAuth,
  insertTag,
  insertTicket,
  STAFF_ORG_ID,
  type SupportTestWorld,
  seedSupportWorld,
  type TestAuth,
  type TestRole,
} from "./test-utils";
import { createTicket } from "./tickets";

const OLD = new Date("2020-01-01T00:00:00.000Z");

// lets the clock move, so messages written one after another get distinct createdAt
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

async function setup(opts: SupportOptions = {}) {
  const events: ByoEvent[] = [];
  const auth = createTestAuth({
    staffOrganizationId: STAFF_ORG_ID,
    onEvent: (event) => void events.push(event),
    ...opts,
  });
  const world = await seedSupportWorld(auth);
  const rt = await authRuntime(auth, "agent.test");
  return { auth, world, rt, events };
}

type Setup = Awaited<ReturnType<typeof setup>>;

const failsWith = (status: string, code?: { code: string }) =>
  expect.objectContaining({
    status,
    ...(code ? { body: expect.objectContaining({ code: code.code }) } : {}),
  });

// zod's own 400, raised before the handler runs
const invalidInput = expect.objectContaining({
  statusCode: 400,
  body: expect.objectContaining({ code: "VALIDATION_ERROR" }),
});

const notAllowed = failsWith("FORBIDDEN", SUPPORT_ERROR_CODES.NOT_ALLOWED);
const notAnAgent = failsWith("BAD_REQUEST", SUPPORT_ERROR_CODES.NOT_AN_AGENT);
const notFound = failsWith("NOT_FOUND", SUPPORT_ERROR_CODES.TICKET_NOT_FOUND);

/** A web ticket from the customer, through `createTicket` (first message included). */
async function openTicket(
  s: Setup,
  input: { subject?: string; organizationId?: string | null } = {},
): Promise<SupportTicketRow> {
  const { ticket } = await createTicket(s.rt, {
    subject: input.subject ?? "Help",
    body: "It broke",
    channel: "web",
    userId: s.world.customer.user.id,
    organizationId:
      input.organizationId === undefined
        ? s.world.customerOrg.id
        : input.organizationId,
    verified: true,
    actorId: s.world.customer.user.id,
  });
  return ticket;
}

async function reload(
  rt: SupportRuntime,
  id: string,
): Promise<SupportTicketRow> {
  const row = await rt.adapter.findOne<SupportTicketRow>({
    model: "supportTicket",
    where: [{ field: "id", value: id }],
  });
  if (!row) throw new Error("ticket vanished");
  return row;
}

async function messagesOf(
  rt: SupportRuntime,
  ticketId: string,
): Promise<SupportMessageRow[]> {
  const rows = await rt.adapter.findMany<SupportMessageRow>({
    model: "supportMessage",
    where: [{ field: "ticketId", value: ticketId }],
    limit: 1000,
    sortBy: { field: "createdAt", direction: "asc" },
  });
  return rows;
}

async function tagsOf(rt: SupportRuntime, ticketId: string) {
  const rows = await rt.adapter.findMany<SupportTicketTagRow>({
    model: "supportTicketTag",
    where: [{ field: "ticketId", value: ticketId }],
    limit: 1000,
  });
  return rows.map((row) => row.tag).sort();
}

// ---------------------------------------------------------------------------
// Every agent endpoint N08 owns, with the one action its gate asks for
// ---------------------------------------------------------------------------

type EndpointCase = {
  name: string;
  action: SupportAction;
  call: (
    target: { auth: TestAuth; ticketId: string; cannedId: string },
    headers: Headers,
  ) => Promise<unknown>;
};

const ENDPOINTS: EndpointCase[] = [
  {
    name: "listSupportTickets",
    action: "read",
    call: ({ auth }, headers) =>
      auth.api.listSupportTickets({ query: {}, headers }),
  },
  {
    name: "getSupportTicketAsAgent",
    action: "read",
    call: ({ auth, ticketId }, headers) =>
      auth.api.getSupportTicketAsAgent({ query: { id: ticketId }, headers }),
  },
  {
    name: "replyAsSupportAgent",
    action: "reply",
    call: ({ auth, ticketId }, headers) =>
      auth.api.replyAsSupportAgent({
        body: { ticketId, body: "On it" },
        headers,
      }),
  },
  {
    name: "updateSupportTickets",
    action: "update",
    call: ({ auth, ticketId }, headers) =>
      auth.api.updateSupportTickets({
        body: { ids: [ticketId], priority: "high" },
        headers,
      }),
  },
  {
    name: "markSupportTicketSeenAsAgent",
    action: "read",
    call: ({ auth, ticketId }, headers) =>
      auth.api.markSupportTicketSeenAsAgent({
        body: { id: ticketId },
        headers,
      }),
  },
  {
    name: "listSupportTags",
    action: "read",
    call: ({ auth }, headers) => auth.api.listSupportTags({ headers }),
  },
  {
    name: "listSupportCannedReplies",
    action: "read",
    call: ({ auth }, headers) =>
      auth.api.listSupportCannedReplies({ query: {}, headers }),
  },
  {
    name: "saveSupportCannedReply",
    action: "manage",
    call: ({ auth }, headers) =>
      auth.api.saveSupportCannedReply({
        body: { title: "Thanks", body: "Thanks for writing in." },
        headers,
      }),
  },
  {
    name: "deleteSupportCannedReply",
    action: "manage",
    call: ({ auth, cannedId }, headers) =>
      auth.api.deleteSupportCannedReply({ body: { id: cannedId }, headers }),
  },
];

const LACKS: Record<Exclude<SupportAction, "delete">, TestRole> = {
  read: "lacksRead",
  reply: "lacksReply",
  update: "lacksUpdate",
  manage: "lacksManage",
};

// ---------------------------------------------------------------------------
// J6: the queue
// ---------------------------------------------------------------------------

describe("listSupportTickets (J6)", () => {
  let s: Setup;
  let t: Record<"a" | "b" | "c" | "d", SupportTicketRow>;

  beforeAll(async () => {
    s = await setup();
    const { world } = s;
    const at = (minutes: number) => new Date(OLD.getTime() + minutes * 60_000);
    t = {
      a: await insertTicket(s.auth, {
        subject: "Login broken",
        userId: world.customer.user.id,
        organizationId: world.customerOrg.id,
        assigneeId: world.agents.member.user.id,
        lastMessageAt: at(4),
      }),
      b: await insertTicket(s.auth, {
        subject: "Crash on save",
        status: "pending",
        userId: world.teammate.user.id,
        organizationId: world.customerOrg.id,
        lastMessageAt: at(3),
      }),
      c: await insertTicket(s.auth, {
        subject: "Old question",
        status: "solved",
        requesterEmail: "someone@mail.test",
        requesterName: "Some One",
        channel: "email",
        assigneeId: world.agents.owner.user.id,
        lastMessageAt: at(2),
        agentSeenAt: at(5),
      }),
      d: await insertTicket(s.auth, {
        subject: "Invoice QUESTION",
        userId: world.outsider.user.id,
        lastMessageAt: at(1),
      }),
    };
    await insertTag(s.auth, { ticketId: t.a.id, tag: "billing" });
    await insertTag(s.auth, { ticketId: t.a.id, tag: "auth" });
    await insertTag(s.auth, { ticketId: t.b.id, tag: "bug" });
    await insertTag(s.auth, { ticketId: t.d.id, tag: "billing" });
  });

  const list = (query: AgentListFilters = {}, role: TestRole = "member") =>
    s.auth.api.listSupportTickets({
      query,
      headers: s.world.agents[role].headers,
    });
  const ids = (r: { tickets: { id: string }[] }) => r.tickets.map((x) => x.id);

  it("lists every ticket newest first, as agent tickets with tags, people and unread", async () => {
    const res = await list();
    expect(ids(res)).toEqual([t.a.id, t.b.id, t.c.id, t.d.id]);
    expect(res.nextCursor).toBeNull();
    const [a, , c] = res.tickets;
    expect(a?.tags).toEqual(["auth", "billing"]);
    expect(a?.assignee).toEqual({
      id: s.world.agents.member.user.id,
      name: "Agent member",
      image: null,
    });
    expect(a?.requester).toMatchObject({
      id: s.world.customer.user.id,
      email: "customer@acme.test",
      name: "Cora Customer",
    });
    expect(a?.unread).toBe(true);
    expect(c?.requester).toEqual({
      id: null,
      name: "Some One",
      email: "someone@mail.test",
      image: null,
    });
    expect(c?.unread).toBe(false);
    for (const ticket of res.tickets) {
      expect(ticket).not.toHaveProperty("replyToken");
    }
  });

  it("filters by status", async () => {
    expect(ids(await list({ status: "open" }))).toEqual([t.a.id, t.d.id]);
    expect(ids(await list({ status: "pending" }))).toEqual([t.b.id]);
    expect(ids(await list({ status: "closed" }))).toEqual([]);
  });

  it("filters by assignee: a user id, me, none", async () => {
    expect(ids(await list({ assignee: s.world.agents.owner.user.id }))).toEqual(
      [t.c.id],
    );
    expect(ids(await list({ assignee: "me" }, "member"))).toEqual([t.a.id]);
    expect(ids(await list({ assignee: "me" }, "owner"))).toEqual([t.c.id]);
    expect(ids(await list({ assignee: "none" }))).toEqual([t.b.id, t.d.id]);
  });

  it("filters by tag (normalized), organization and q", async () => {
    expect(ids(await list({ tag: "billing" }))).toEqual([t.a.id, t.d.id]);
    expect(ids(await list({ tag: " BUG " }))).toEqual([t.b.id]);
    expect(ids(await list({ tag: "nope" }))).toEqual([]);
    expect(ids(await list({ organizationId: s.world.customerOrg.id }))).toEqual(
      [t.a.id, t.b.id],
    );
    expect(ids(await list({ q: `#${t.c.number}` }))).toEqual([t.c.id]);
    expect(ids(await list({ q: String(t.b.number) }))).toEqual([t.b.id]);
    expect(ids(await list({ q: "invoice" }))).toEqual([t.d.id]);
    expect(
      ids(await list({ tag: "billing", status: "open", q: "login" })),
    ).toEqual([t.a.id]);
  });

  it("filters by requester: a user id, or an account-less sender's email in any case", async () => {
    expect(ids(await list({ requesterId: s.world.customer.user.id }))).toEqual([
      t.a.id,
    ]);
    expect(ids(await list({ requesterEmail: "SomeOne@Mail.test" }))).toEqual([
      t.c.id,
    ]);
    expect(
      ids(
        await list({
          requesterId: s.world.customer.user.id,
          status: "pending",
        }),
      ),
    ).toEqual([]);
  });

  it("returns queue-wide counts, whatever the filters", async () => {
    const expected = { open: 2, pending: 1, unassigned: 2, mine: 1 };
    expect((await list()).counts).toEqual(expected);
    expect((await list({ status: "solved" })).counts).toEqual(expected);
    expect((await list({}, "owner")).counts).toEqual({ ...expected, mine: 0 });
  });

  it("returns the server's features (attachments off, merge on)", async () => {
    expect((await list()).features).toEqual({
      attachments: false,
      merge: true,
    });
  });
});

describe("listSupportTickets paging", () => {
  it("pages with a cursor across a lastMessageAt tie, every ticket once", async () => {
    const s = await setup({ pageSize: 2 });
    const created: string[] = [];
    for (let i = 0; i < 5; i++) {
      const row = await insertTicket(s.auth, {
        userId: s.world.customer.user.id,
        lastMessageAt: i < 4 ? OLD : new Date(OLD.getTime() + 1000),
      });
      created.push(row.id);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const res = await s.auth.api.listSupportTickets({
        query: cursor ? { cursor } : {},
        headers: s.world.agents.readOnly.headers,
      });
      expect(res.tickets.length).toBeLessThanOrEqual(2);
      seen.push(...res.tickets.map((x) => x.id));
      if (!res.nextCursor) break;
      cursor = res.nextCursor;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen)).toEqual(new Set(created));
    expect(seen[0]).toBe(created[4]);
  });

  it("answers 400 INVALID_CURSOR for a malformed cursor", async () => {
    const s = await setup();
    await expect(
      s.auth.api.listSupportTickets({
        query: { cursor: "not-a-cursor" },
        headers: s.world.agents.member.headers,
      }),
    ).rejects.toEqual(
      failsWith("BAD_REQUEST", SUPPORT_ERROR_CODES.INVALID_CURSOR),
    );
  });

  it("reports attachments: true when storage is configured", async () => {
    const storage: SupportStorage = {
      put: async () => {},
      get: async () => null,
      delete: async () => {},
      deletePrefix: async () => {},
    };
    const s = await setup({ attachments: { storage } });
    const res = await s.auth.api.listSupportTickets({
      query: {},
      headers: s.world.agents.member.headers,
    });
    expect(res.features).toEqual({ attachments: true, merge: true });
  });
});

// ---------------------------------------------------------------------------
// J7: the thread, replies and notes
// ---------------------------------------------------------------------------

describe("getSupportTicketAsAgent and markSupportTicketSeenAsAgent", () => {
  it("returns the ticket, every message (notes and events too) oldest first, and attachments", async () => {
    const s = await setup();
    const ticket = await openTicket(s);
    await s.auth.api.updateSupportTickets({
      body: { ids: [ticket.id], addTags: ["Billing"] },
      headers: s.world.agents.member.headers,
    });
    await tick();
    await s.auth.api.replyAsSupportAgent({
      body: {
        ticketId: ticket.id,
        body: "Internal: check logs",
        internal: true,
      },
      headers: s.world.agents.member.headers,
    });
    await tick();
    await s.auth.api.replyAsSupportAgent({
      body: { ticketId: ticket.id, body: "Looking into it" },
      headers: s.world.agents.admin.headers,
    });

    const res = await s.auth.api.getSupportTicketAsAgent({
      query: { id: ticket.id },
      headers: s.world.agents.readOnly.headers,
    });
    expect(res.ticket).toMatchObject({
      id: ticket.id,
      status: "pending",
      tags: ["billing"],
      verified: true,
    });
    expect(res.ticket).not.toHaveProperty("replyToken");
    expect(res.messages.map((m) => [m.kind, m.body])).toEqual([
      ["reply", "It broke"],
      ["note", "Internal: check logs"],
      ["reply", "Looking into it"],
      ["event", ""],
    ]);
    expect(res.messages[0]?.author).toMatchObject({
      id: s.world.customer.user.id,
      email: "customer@acme.test",
    });
    expect(res.messages[2]?.author).toMatchObject({
      id: s.world.agents.admin.user.id,
      name: "Agent admin",
    });
    expect(res.messages[3]?.data).toEqual({
      type: "status",
      from: "open",
      to: "pending",
    });
    expect(res.attachments).toEqual([]);
  });

  it("marks the ticket seen by agents", async () => {
    const s = await setup();
    const ticket = await openTicket(s);
    const before = await s.auth.api.getSupportTicketAsAgent({
      query: { id: ticket.id },
      headers: s.world.agents.member.headers,
    });
    expect(before.ticket.unread).toBe(true);
    await expect(
      s.auth.api.markSupportTicketSeenAsAgent({
        body: { id: ticket.id },
        headers: s.world.agents.readOnly.headers,
      }),
    ).resolves.toEqual({ ok: true });
    const row = await reload(s.rt, ticket.id);
    expect(row.agentSeenAt).toBeInstanceOf(Date);
    const after = await s.auth.api.getSupportTicketAsAgent({
      query: { id: ticket.id },
      headers: s.world.agents.member.headers,
    });
    expect(after.ticket.unread).toBe(false);
  });

  it("answers 404 TICKET_NOT_FOUND for an unknown ticket id", async () => {
    const s = await setup();
    const headers = s.world.agents.owner.headers;
    await expect(
      s.auth.api.getSupportTicketAsAgent({ query: { id: "nope" }, headers }),
    ).rejects.toEqual(notFound);
    await expect(
      s.auth.api.replyAsSupportAgent({
        body: { ticketId: "nope", body: "Hi" },
        headers,
      }),
    ).rejects.toEqual(notFound);
    await expect(
      s.auth.api.markSupportTicketSeenAsAgent({
        body: { id: "nope" },
        headers,
      }),
    ).rejects.toEqual(notFound);
  });
});

describe("replyAsSupportAgent (J7)", () => {
  it("a reply sets pending by default, marks agent-seen and emits support.agent.replied", async () => {
    const s = await setup();
    const ticket = await openTicket(s);
    s.events.length = 0;
    const res = await s.auth.api.replyAsSupportAgent({
      body: { ticketId: ticket.id, body: "We are on it" },
      headers: s.world.agents.member.headers,
    });
    expect(res.message).toMatchObject({
      ticketId: ticket.id,
      kind: "reply",
      authorType: "agent",
      userId: s.world.agents.member.user.id,
      body: "We are on it",
      mentions: [],
      channel: "web",
      verified: true,
    });
    expect(res.message.author?.name).toBe("Agent member");
    const row = await reload(s.rt, ticket.id);
    expect(row.status).toBe("pending");
    expect(row.agentSeenAt).toBeInstanceOf(Date);
    expect(row.lastMessageAt.getTime()).toBeGreaterThanOrEqual(
      ticket.lastMessageAt.getTime(),
    );
    expect(s.events.map((e) => e.type)).toEqual([
      "support.ticket.status_changed",
      "support.agent.replied",
    ]);
    expect(s.events[1]?.data).toEqual({
      ticketId: ticket.id,
      messageId: res.message.id,
      status: "pending",
      visibility: "private",
    });
  });

  it("a reply with status sets that status (solved sets solvedAt)", async () => {
    const s = await setup();
    const ticket = await openTicket(s);
    await s.auth.api.replyAsSupportAgent({
      body: { ticketId: ticket.id, body: "Fixed", status: "solved" },
      headers: s.world.agents.member.headers,
    });
    const row = await reload(s.rt, ticket.id);
    expect(row.status).toBe("solved");
    expect(row.solvedAt).toBeInstanceOf(Date);
  });

  it("a note keeps the status, doesn't bump lastMessageAt, and never reaches the customer serializer", async () => {
    const s = await setup();
    const ticket = await openTicket(s);
    s.events.length = 0;
    const res = await s.auth.api.replyAsSupportAgent({
      body: { ticketId: ticket.id, body: "Secret note", internal: true },
      headers: s.world.agents.member.headers,
    });
    expect(res.message.kind).toBe("note");
    const row = await reload(s.rt, ticket.id);
    expect(row.status).toBe("open");
    expect(row.lastMessageAt.getTime()).toBe(ticket.lastMessageAt.getTime());
    expect(row.agentSeenAt).toBeInstanceOf(Date);
    expect(s.events.map((e) => e.type)).toEqual(["support.note.added"]);

    const stored = (await messagesOf(s.rt, ticket.id)).find(
      (m) => m.id === res.message.id,
    );
    expect(stored).toBeDefined();
    expect(
      toCustomerMessage(stored as SupportMessageRow, new Map()),
    ).toBeNull();
  });

  it("a note with status changes it", async () => {
    const s = await setup();
    const ticket = await openTicket(s);
    await s.auth.api.replyAsSupportAgent({
      body: {
        ticketId: ticket.id,
        body: "Waiting on vendor",
        internal: true,
        status: "pending",
      },
      headers: s.world.agents.member.headers,
    });
    expect((await reload(s.rt, ticket.id)).status).toBe("pending");
  });

  it("refuses a reply or note on a closed ticket (TICKET_CLOSED), writing nothing", async () => {
    const s = await setup();
    const ticket = await insertTicket(s.auth, {
      userId: s.world.customer.user.id,
      status: "closed",
    });
    for (const internal of [false, true]) {
      await expect(
        s.auth.api.replyAsSupportAgent({
          body: { ticketId: ticket.id, body: "Hi", internal },
          headers: s.world.agents.member.headers,
        }),
      ).rejects.toEqual(
        failsWith("BAD_REQUEST", SUPPORT_ERROR_CODES.TICKET_CLOSED),
      );
    }
    expect(await messagesOf(s.rt, ticket.id)).toEqual([]);
  });

  it("refuses attachmentIds without attachments configured", async () => {
    const s = await setup();
    const ticket = await openTicket(s);
    await expect(
      s.auth.api.replyAsSupportAgent({
        body: { ticketId: ticket.id, body: "See file", attachmentIds: ["x"] },
        headers: s.world.agents.member.headers,
      }),
    ).rejects.toEqual(
      failsWith("BAD_REQUEST", SUPPORT_ERROR_CODES.STORAGE_NOT_CONFIGURED),
    );
    expect(await messagesOf(s.rt, ticket.id)).toHaveLength(1);
  });

  it("validates the body: empty, whitespace-only, over the limit, too many mentions", async () => {
    const s = await setup();
    const ticket = await openTicket(s);
    const headers = s.world.agents.member.headers;
    for (const body of [
      { ticketId: ticket.id, body: "" },
      { ticketId: ticket.id, body: "   " },
      { ticketId: ticket.id, body: "x".repeat(50_001) },
      {
        ticketId: ticket.id,
        body: "hi",
        mentions: Array.from({ length: 21 }, (_, i) => `u${i}`),
      },
    ]) {
      await expect(
        s.auth.api.replyAsSupportAgent({ body, headers }),
      ).rejects.toEqual(invalidInput);
    }
  });
});

// ---------------------------------------------------------------------------
// J8: status, priority, assignee, tags, one or many
// ---------------------------------------------------------------------------

describe("updateSupportTickets (J8)", () => {
  it("walks the status transitions agents may make, with solvedAt and event rows", async () => {
    const s = await setup();
    const ticket = await openTicket(s);
    const headers = s.world.agents.member.headers;
    const set = (status: SupportTicketRow["status"]) =>
      s.auth.api.updateSupportTickets({
        body: { ids: [ticket.id], status },
        headers,
      });

    await set("pending");
    let row = await reload(s.rt, ticket.id);
    expect(row.status).toBe("pending");
    expect(row.solvedAt ?? null).toBeNull();

    await set("solved");
    row = await reload(s.rt, ticket.id);
    expect(row.status).toBe("solved");
    const solvedAt = row.solvedAt;
    expect(solvedAt).toBeInstanceOf(Date);

    await set("closed");
    row = await reload(s.rt, ticket.id);
    expect(row.status).toBe("closed");
    expect(row.solvedAt).toEqual(solvedAt);

    await set("open");
    row = await reload(s.rt, ticket.id);
    expect(row.status).toBe("open");
    expect(row.solvedAt ?? null).toBeNull();

    // same status: no-op, no event row
    await set("open");

    const events = (await messagesOf(s.rt, ticket.id))
      .filter((m) => m.kind === "event")
      .map((m) => [m.data?.from, m.data?.to, m.authorType, m.userId]);
    const agent = s.world.agents.member.user.id;
    expect(events).toEqual([
      ["open", "pending", "agent", agent],
      ["pending", "solved", "agent", agent],
      ["solved", "closed", "agent", agent],
      ["closed", "open", "agent", agent],
    ]);
  });

  it("bulk-updates status, priority, assignee and tags on many tickets (chunked), ignoring unknown and duplicate ids", async () => {
    const s = await setup();
    const tickets: SupportTicketRow[] = [];
    for (let i = 0; i < 95; i++) {
      tickets.push(
        await insertTicket(s.auth, {
          userId: s.world.customer.user.id,
          priority: i === 0 ? "high" : null,
        }),
      );
    }
    await insertTag(s.auth, { ticketId: tickets[0]?.id ?? "", tag: "old" });
    const ids = tickets.map((t) => t.id);
    const assignee = s.world.agents.readOnly.user.id;
    s.events.length = 0;

    const res = await s.auth.api.updateSupportTickets({
      body: {
        ids: [...ids, "missing-1", ids[0] ?? ""],
        status: "pending",
        priority: "high",
        assigneeId: assignee,
        addTags: ["VIP", "billing"],
        removeTags: ["old"],
      },
      headers: s.world.agents.member.headers,
    });
    expect(res).toEqual({ updated: 95 });

    for (const t of [tickets[0], tickets[50], tickets[94]]) {
      const row = await reload(s.rt, t?.id ?? "");
      expect(row).toMatchObject({
        status: "pending",
        priority: "high",
        assigneeId: assignee,
      });
      expect(await tagsOf(s.rt, row.id)).toEqual(["billing", "vip"]);
    }

    // the first ticket already had high priority: no priority event there
    const first = await messagesOf(s.rt, tickets[0]?.id ?? "");
    expect(first.map((m) => m.data?.type)).toEqual(["status", "assignee"]);
    const other = await messagesOf(s.rt, tickets[1]?.id ?? "");
    expect(other.map((m) => m.data)).toEqual([
      { type: "status", from: "open", to: "pending" },
      { type: "priority", from: null, to: "high" },
      { type: "assignee", from: null, to: assignee },
    ]);
    expect(other.every((m) => m.authorType === "agent")).toBe(true);

    const assigned = s.events.filter(
      (e) => e.type === "support.ticket.assigned",
    );
    expect(assigned).toHaveLength(95);
    expect(assigned[0]).toMatchObject({
      userId: assignee,
      actorId: s.world.agents.member.user.id,
      data: { from: null, to: assignee },
    });
  });

  it("counts every matched ticket in updated, unchanged ones included", async () => {
    const s = await setup();
    const already = await insertTicket(s.auth, {
      userId: s.world.customer.user.id,
      priority: "high",
    });
    const changes = await insertTicket(s.auth, {
      userId: s.world.customer.user.id,
    });
    s.events.length = 0;
    const res = await s.auth.api.updateSupportTickets({
      body: { ids: [already.id, changes.id, "missing"], priority: "high" },
      headers: s.world.agents.member.headers,
    });
    expect(res).toEqual({ updated: 2 });
    expect((await reload(s.rt, changes.id)).priority).toBe("high");
  });

  it("unassigns (assigneeId null) and clears priority, emitting assigned without a userId", async () => {
    const s = await setup();
    const ticket = await insertTicket(s.auth, {
      userId: s.world.customer.user.id,
      priority: "urgent",
      assigneeId: s.world.agents.admin.user.id,
    });
    s.events.length = 0;
    await s.auth.api.updateSupportTickets({
      body: { ids: [ticket.id], assigneeId: null, priority: null },
      headers: s.world.agents.member.headers,
    });
    const row = await reload(s.rt, ticket.id);
    expect(row.assigneeId ?? null).toBeNull();
    expect(row.priority ?? null).toBeNull();
    const [event] = s.events;
    expect(event?.type).toBe("support.ticket.assigned");
    expect(event?.userId).toBeUndefined();
    expect(event?.data).toEqual({
      ticketId: ticket.id,
      from: s.world.agents.admin.user.id,
      to: null,
      visibility: "private",
    });
  });

  it("refuses more than 100 ids and an empty list", async () => {
    const s = await setup();
    const headers = s.world.agents.member.headers;
    await expect(
      s.auth.api.updateSupportTickets({
        body: { ids: Array.from({ length: 101 }, (_, i) => `t${i}`) },
        headers,
      }),
    ).rejects.toEqual(invalidInput);
    await expect(
      s.auth.api.updateSupportTickets({ body: { ids: [] }, headers }),
    ).rejects.toEqual(invalidInput);
  });

  it("an invalid tag is INVALID_TAG and nothing is written", async () => {
    const s = await setup();
    const ticket = await openTicket(s);
    await expect(
      s.auth.api.updateSupportTickets({
        body: { ids: [ticket.id], status: "solved", addTags: ["ok", "no way"] },
        headers: s.world.agents.member.headers,
      }),
    ).rejects.toEqual(
      failsWith("BAD_REQUEST", SUPPORT_ERROR_CODES.INVALID_TAG),
    );
    expect((await reload(s.rt, ticket.id)).status).toBe("open");
    expect(await tagsOf(s.rt, ticket.id)).toEqual([]);
  });
});

describe("listSupportTags", () => {
  it("returns every tag in use, deduped and sorted", async () => {
    const s = await setup();
    const a = await openTicket(s);
    const b = await openTicket(s);
    await insertTag(s.auth, { ticketId: a.id, tag: "zeta" });
    await insertTag(s.auth, { ticketId: a.id, tag: "alpha" });
    await insertTag(s.auth, { ticketId: b.id, tag: "alpha" });
    await expect(
      s.auth.api.listSupportTags({ headers: s.world.agents.readOnly.headers }),
    ).resolves.toEqual(["alpha", "zeta"]);
  });
});

// ---------------------------------------------------------------------------
// Staff model
// ---------------------------------------------------------------------------

describe("staff model", () => {
  let s: Setup;
  let target: { auth: TestAuth; ticketId: string; cannedId: string };

  beforeAll(async () => {
    s = await setup();
    const ticket = await openTicket(s);
    const canned = await s.auth.api.saveSupportCannedReply({
      body: { title: "Seed", body: "Seed body" },
      headers: s.world.agents.owner.headers,
    });
    target = {
      auth: s.auth,
      ticketId: ticket.id,
      cannedId: canned.cannedReply.id,
    };
  });

  it("a staff member with another org active (not the staff org) can act", async () => {
    const agent = s.world.agents.member;
    const side = await createOrganization(s.auth, agent, { name: "Side" });
    await s.auth.api.setActiveOrganization({
      body: { organizationId: side.id },
      headers: agent.headers,
    });
    const session = await s.auth.api.getSession({ headers: agent.headers });
    expect(
      (session?.session as { activeOrganizationId?: string | null } | undefined)
        ?.activeOrganizationId,
    ).toBe(side.id);
    for (const endpoint of ENDPOINTS.filter((e) => e.action !== "manage")) {
      await expect(endpoint.call(target, agent.headers)).resolves.toBeTruthy();
    }
  });

  it("a customer-org owner is denied on every endpoint, even with their org active", async () => {
    await s.auth.api.setActiveOrganization({
      body: { organizationId: s.world.customerOrg.id },
      headers: s.world.customer.headers,
    });
    for (const endpoint of ENDPOINTS) {
      await expect(
        endpoint.call(target, s.world.customer.headers),
      ).rejects.toEqual(notAllowed);
    }
  });

  it("outsiders and staff with no support role (billing) are denied", async () => {
    for (const user of [s.world.outsider, s.world.agents.billing]) {
      for (const endpoint of ENDPOINTS) {
        await expect(endpoint.call(target, user.headers)).rejects.toEqual(
          notAllowed,
        );
      }
    }
  });

  it("without a session every endpoint answers 401", async () => {
    for (const endpoint of ENDPOINTS) {
      await expect(endpoint.call(target, new Headers())).rejects.toEqual(
        failsWith("UNAUTHORIZED"),
      );
    }
  });

  for (const endpoint of ENDPOINTS) {
    it(`${endpoint.name} denies the staff role lacking exactly support:${endpoint.action}, allows the others`, async () => {
      const lacking =
        LACKS[endpoint.action as Exclude<SupportAction, "delete">];
      await expect(
        endpoint.call(target, s.world.agents[lacking].headers),
      ).rejects.toEqual(notAllowed);
      for (const role of Object.values(LACKS)) {
        if (role === lacking) continue;
        await expect(
          endpoint.call(target, s.world.agents[role].headers),
        ).resolves.toBeTruthy();
      }
      await expect(
        endpoint.call(target, s.world.agents.lacksDelete.headers),
      ).resolves.toBeTruthy();
    });
  }
});

describe("no staffOrganizationId", () => {
  it("denies every endpoint, even to the would-be staff owner", async () => {
    const auth = createTestAuth({});
    const world: SupportTestWorld = await seedSupportWorld(auth);
    const rt = await authRuntime(auth, "agent.test");
    const { ticket } = await createTicket(rt, {
      subject: "Help",
      body: "Hi",
      channel: "web",
      userId: world.customer.user.id,
      verified: true,
      actorId: world.customer.user.id,
    });
    const target = { auth, ticketId: ticket.id, cannedId: "none" };
    for (const endpoint of ENDPOINTS) {
      await expect(
        endpoint.call(target, world.agents.owner.headers),
      ).rejects.toEqual(notAllowed);
    }
  });
});

// ---------------------------------------------------------------------------
// isAgent: assignees and mentions
// ---------------------------------------------------------------------------

describe("assignees and mentions must be agents (NOT_AN_AGENT)", () => {
  let s: Setup;
  beforeAll(async () => {
    s = await setup();
  });

  it("refuses assigning a billing staff member, a customer or an unknown id, writing nothing", async () => {
    const ticket = await openTicket(s);
    for (const assigneeId of [
      s.world.agents.billing.user.id,
      s.world.customer.user.id,
      "no-such-user",
    ]) {
      await expect(
        s.auth.api.updateSupportTickets({
          body: { ids: [ticket.id], assigneeId, status: "solved" },
          headers: s.world.agents.member.headers,
        }),
      ).rejects.toEqual(notAnAgent);
    }
    const row = await reload(s.rt, ticket.id);
    expect(row.assigneeId ?? null).toBeNull();
    expect(row.status).toBe("open");
  });

  it("allows assigning any staff member whose role has support:read", async () => {
    const ticket = await openTicket(s);
    await s.auth.api.updateSupportTickets({
      body: { ids: [ticket.id], assigneeId: s.world.agents.lacksReply.user.id },
      headers: s.world.agents.member.headers,
    });
    expect((await reload(s.rt, ticket.id)).assigneeId).toBe(
      s.world.agents.lacksReply.user.id,
    );
  });

  it("refuses mentioning a billing staff member or a customer, writing nothing", async () => {
    const ticket = await openTicket(s);
    for (const mention of [
      s.world.agents.billing.user.id,
      s.world.customer.user.id,
    ]) {
      for (const internal of [false, true]) {
        await expect(
          s.auth.api.replyAsSupportAgent({
            body: {
              ticketId: ticket.id,
              body: "Hey",
              internal,
              mentions: [s.world.agents.admin.user.id, mention],
            },
            headers: s.world.agents.member.headers,
          }),
        ).rejects.toEqual(notAnAgent);
      }
    }
    expect(await messagesOf(s.rt, ticket.id)).toHaveLength(1);
  });

  it("uses the app's isAgent when given", async () => {
    const outsiderAgent = await setup({
      isAgent: (userId) => userId !== "not-an-agent",
    });
    const ticket = await openTicket(outsiderAgent);
    // the customer is not staff, but the app's isAgent says yes
    await outsiderAgent.auth.api.updateSupportTickets({
      body: {
        ids: [ticket.id],
        assigneeId: outsiderAgent.world.customer.user.id,
      },
      headers: outsiderAgent.world.agents.member.headers,
    });
    expect((await reload(outsiderAgent.rt, ticket.id)).assigneeId).toBe(
      outsiderAgent.world.customer.user.id,
    );
    await expect(
      outsiderAgent.auth.api.updateSupportTickets({
        body: { ids: [ticket.id], assigneeId: "not-an-agent" },
        headers: outsiderAgent.world.agents.member.headers,
      }),
    ).rejects.toEqual(notAnAgent);
  });
});
