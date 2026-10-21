import { beforeEach, describe, expect, it, vi } from "vitest";
import { authRuntime } from "./adapter";
import { SUPPORT_ERROR_CODES } from "./error-codes";
import type { SupportOptions, SupportStorage } from "./options";
import type { SupportMessageRow, SupportTicketRow } from "./schema";
import {
  type AdapterCall,
  addMember,
  createOrganization,
  createTestAuth,
  getContext,
  insertMessage,
  removeMember,
  STAFF_ORG_ID,
  type SupportTestWorld,
  seedSupportWorld,
  signUpUser,
  type TestAuth,
  type TestUser,
} from "./test-utils";
import { addMessage } from "./tickets";

// `merge.ts` belongs to another node and is still the identity here. These
// tests stand in a minimal resolver (follow `mergedIntoId`, at most 10 hops)
// so the routes' merge-follow rule (D2) is exercised; nothing else in this
// file sets `mergedIntoId`, so every other test sees the identity.
vi.mock("./merge", () => ({
  resolveMergedTicket: async (
    adapter: import("better-auth").DBTransactionAdapter,
    ticket: import("./schema").SupportTicketRow,
  ) => {
    let current = ticket;
    for (let hop = 0; hop < 10 && current.mergedIntoId; hop++) {
      const next = await adapter.findOne<import("./schema").SupportTicketRow>({
        model: "supportTicket",
        where: [{ field: "id", value: current.mergedIntoId }],
      });
      if (!next) break;
      current = next;
    }
    return current;
  },
}));

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const error = (status: string, code?: { code: string }) =>
  expect.objectContaining({
    status,
    ...(code ? { body: expect.objectContaining({ code: code.code }) } : {}),
  });

const notFound = error("NOT_FOUND", SUPPORT_ERROR_CODES.TICKET_NOT_FOUND);
const notAllowed = error("FORBIDDEN", SUPPORT_ERROR_CODES.NOT_ALLOWED);
const notAMember = error("FORBIDDEN", SUPPORT_ERROR_CODES.NOT_A_MEMBER);
const ticketClosed = error("BAD_REQUEST", SUPPORT_ERROR_CODES.TICKET_CLOSED);
const badTransition = error(
  "BAD_REQUEST",
  SUPPORT_ERROR_CODES.INVALID_STATUS_TRANSITION,
);
/** better-auth's own zod failure (a 400 with `VALIDATION_ERROR`). */
const invalidInput = expect.objectContaining({
  statusCode: 400,
  body: expect.objectContaining({ code: "VALIDATION_ERROR" }),
});

/** A storage that satisfies the type; nothing here reads or writes blobs. */
const fakeStorage: SupportStorage = {
  put: async () => {},
  get: async () => null,
  delete: async () => {},
  deletePrefix: async () => {},
};

let auth: TestAuth;
let w: SupportTestWorld;
let calls: AdapterCall[];

async function setup(opts: SupportOptions = {}) {
  calls = [];
  auth = createTestAuth(
    { staffOrganizationId: STAFF_ORG_ID, ...opts },
    { adapter: { before: (call) => void calls.push(call) } },
  );
  w = await seedSupportWorld(auth);
}

const create = (
  user: TestUser,
  body: {
    subject?: string;
    body?: string;
    organizationId?: string;
    visibility?: "private" | "organization";
  } = {},
) =>
  auth.api.createSupportTicket({
    body: { subject: "Help", body: "It broke", ...body },
    headers: user.headers,
  });

const list = (user: TestUser, query: Record<string, string> = {}) =>
  auth.api.listMySupportTickets({ query, headers: user.headers });

const get = (user: TestUser, id: string) =>
  auth.api.getSupportTicket({ query: { id }, headers: user.headers });

const reply = (
  user: TestUser,
  ticketId: string,
  body = "More detail",
  attachmentIds?: string[],
) =>
  auth.api.replyToSupportTicket({
    body: { ticketId, body, ...(attachmentIds ? { attachmentIds } : {}) },
    headers: user.headers,
  });

const updateMine = (
  user: TestUser,
  id: string,
  body: {
    status?: "solved" | "open";
    visibility?: "private" | "organization";
    rating?: "good" | "bad";
  },
) =>
  auth.api.updateMySupportTicket({
    body: { id, ...body },
    headers: user.headers,
  });

const markSeen = (user: TestUser, id: string) =>
  auth.api.markSupportTicketSeen({ body: { id }, headers: user.headers });

async function row(id: string): Promise<SupportTicketRow> {
  const { adapter } = await getContext(auth);
  const found = await adapter.findOne<SupportTicketRow>({
    model: "supportTicket",
    where: [{ field: "id", value: id }],
  });
  if (!found) throw new Error("ticket vanished");
  return found;
}

async function messagesOf(ticketId: string): Promise<SupportMessageRow[]> {
  const { adapter } = await getContext(auth);
  return adapter.findMany<SupportMessageRow>({
    model: "supportMessage",
    where: [{ field: "ticketId", value: ticketId }],
    limit: 100,
  });
}

async function setStatus(id: string, status: SupportTicketRow["status"]) {
  const { adapter } = await getContext(auth);
  await adapter.update({
    model: "supportTicket",
    where: [{ field: "id", value: id }],
    update: { status },
  });
}

/** Moves the requester's seen mark into the past, so a reply in the same millisecond is unread. */
async function backdateSeen(id: string) {
  const { adapter } = await getContext(auth);
  await adapter.update({
    model: "supportTicket",
    where: [{ field: "id", value: id }],
    update: { requesterSeenAt: new Date(Date.now() - 60_000) },
  });
}

/** An agent reply (or note) through `tickets.addMessage`, as the agent routes will do. */
async function agentMessage(
  ticketId: string,
  input: { body: string; kind?: "reply" | "note"; mentions?: string[] },
) {
  const rt = await authRuntime(auth, "customer.test");
  return addMessage(rt, {
    ticket: await row(ticketId),
    kind: input.kind ?? "reply",
    authorType: "agent",
    userId: w.agents.member.user.id,
    body: input.body,
    mentions: input.mentions,
    channel: "web",
    verified: true,
    actorId: w.agents.member.user.id,
  });
}

/** A ticket from the customer shared with their org. */
const sharedTicket = async () =>
  (
    await create(w.customer, {
      subject: "Shared",
      organizationId: w.customerOrg.id,
      visibility: "organization",
    })
  ).ticket;

/** Every key anywhere in a response. */
function keysOf(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) keysOf(item, out);
  } else if (value && typeof value === "object" && !(value instanceof Date)) {
    for (const [key, inner] of Object.entries(value)) {
      out.add(key);
      keysOf(inner, out);
    }
  }
  return out;
}

const HIDDEN_KEYS = [
  "replyToken",
  "assigneeId",
  "assignee",
  "agentSeenAt",
  "requesterSeenAt",
  "mentions",
  "verified",
  "emailMessageId",
  "userId",
  "requesterEmail",
  "requesterName",
  "authorEmail",
  "mergedIntoId",
  "internal",
  "storageKey",
  "email",
];

function expectNoHiddenFields(response: unknown) {
  const keys = keysOf(response);
  for (const key of HIDDEN_KEYS) expect(keys, key).not.toContain(key);
}

// ---------------------------------------------------------------------------
// J1: open a ticket and see it in my list
// ---------------------------------------------------------------------------

describe("createSupportTicket (J1)", () => {
  beforeEach(() => setup());

  it("opens a private, verified web ticket owned by the caller", async () => {
    const { ticket } = await create(w.customer, {
      subject: "  Login fails  ",
      body: "Since this morning",
    });
    expect(ticket).toMatchObject({
      subject: "Login fails",
      status: "open",
      channel: "web",
      visibility: "private",
      organizationId: null,
      rating: null,
      solvedAt: null,
      unread: false,
      isRequester: true,
    });
    expect(ticket.number).toBeGreaterThan(0);
    const stored = await row(ticket.id);
    expect(stored).toMatchObject({
      userId: w.customer.user.id,
      verified: true,
      channel: "web",
    });
    const messages = await messagesOf(ticket.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      kind: "reply",
      authorType: "customer",
      userId: w.customer.user.id,
      body: "Since this morning",
    });
    const { tickets } = await list(w.customer);
    expect(tickets.map((t) => t.id)).toEqual([ticket.id]);
  });

  it("files a ticket under an organization the caller belongs to", async () => {
    const { ticket } = await create(w.teammate, {
      organizationId: w.customerOrg.id,
    });
    expect(ticket).toMatchObject({
      organizationId: w.customerOrg.id,
      visibility: "private",
    });
    const shared = await sharedTicket();
    expect(shared).toMatchObject({
      organizationId: w.customerOrg.id,
      visibility: "organization",
    });
  });

  it("checks membership with the caller's memberships: NOT_A_MEMBER otherwise", async () => {
    await expect(
      create(w.outsider, { organizationId: w.customerOrg.id }),
    ).rejects.toEqual(notAMember);
    await expect(
      create(w.outsider, {
        organizationId: w.customerOrg.id,
        visibility: "organization",
      }),
    ).rejects.toEqual(notAMember);
    await expect(
      create(w.customer, { organizationId: "org_missing" }),
    ).rejects.toEqual(notAMember);
    const memberReads = calls.filter(
      (c) => c.model === "member" && c.method === "findMany",
    );
    expect(memberReads.length).toBeGreaterThan(0);
    expect(await list(w.outsider)).toMatchObject({ tickets: [] });
  });

  it("refuses visibility organization without an organizationId (NOT_ALLOWED)", async () => {
    await expect(
      create(w.customer, { visibility: "organization" }),
    ).rejects.toEqual(notAllowed);
  });

  it("validates the input with the support limits", async () => {
    await expect(create(w.customer, { subject: "   " })).rejects.toEqual(
      invalidInput,
    );
    await expect(
      create(w.customer, { subject: "x".repeat(201) }),
    ).rejects.toEqual(invalidInput);
    await expect(create(w.customer, { body: "" })).rejects.toEqual(
      invalidInput,
    );
    await expect(
      create(w.customer, { body: "x".repeat(50_001) }),
    ).rejects.toEqual(invalidInput);
    expect(await list(w.customer)).toMatchObject({ tickets: [] });
  });
});

describe("listMySupportTickets (J1)", () => {
  beforeEach(() => setup());

  it("lists own tickets plus org-shared ones, two queries merged, newest first", async () => {
    const own = (await create(w.customer, { subject: "Own private" })).ticket;
    const shared = await sharedTicket();
    const teammatePrivate = (
      await create(w.teammate, {
        subject: "Teammate private",
        organizationId: w.customerOrg.id,
      })
    ).ticket;
    const teammateShared = (
      await create(w.teammate, {
        subject: "Teammate shared",
        organizationId: w.customerOrg.id,
        visibility: "organization",
      })
    ).ticket;
    // distinct activity times, oldest first, so the order doesn't hang on ids
    const { adapter } = await getContext(auth);
    const base = Date.now() - 60_000;
    for (const [i, t] of [
      own,
      shared,
      teammatePrivate,
      teammateShared,
    ].entries()) {
      await adapter.update({
        model: "supportTicket",
        where: [{ field: "id", value: t.id }],
        update: { lastMessageAt: new Date(base + i * 1000) },
      });
    }

    calls.length = 0;
    const mine = await list(w.customer);
    // newest lastMessageAt first; a ticket both own and shared once
    expect(mine.tickets.map((t) => t.id)).toEqual([
      teammateShared.id,
      shared.id,
      own.id,
    ]);
    const ticketReads = calls.filter(
      (c) => c.model === "supportTicket" && c.method === "findMany",
    );
    expect(ticketReads).toHaveLength(2);

    const theirs = await list(w.teammate);
    expect(theirs.tickets.map((t) => t.id)).toEqual([
      teammateShared.id,
      teammatePrivate.id,
      shared.id,
    ]);
    // teammates never see a ticket as unread
    const sharedForTeammate = theirs.tickets.find((t) => t.id === shared.id);
    expect(sharedForTeammate?.unread).toBe(false);
    // and not the requester, unlike the owner's own view of the same ticket
    expect(sharedForTeammate?.isRequester).toBe(false);
    expect(mine.tickets.find((t) => t.id === shared.id)?.isRequester).toBe(
      true,
    );
    expect(
      mine.tickets.find((t) => t.id === teammateShared.id)?.isRequester,
    ).toBe(false);

    expect((await list(w.outsider)).tickets).toEqual([]);
    expect(mine.nextCursor).toBeNull();
    expectNoHiddenFields(mine);
  });

  it("filters by status, organization and q", async () => {
    const a = (await create(w.customer, { subject: "Billing question" }))
      .ticket;
    const b = await sharedTicket();
    await updateMine(w.customer, a.id, { status: "solved" });

    const solved = await list(w.customer, { status: "solved" });
    expect(solved.tickets.map((t) => t.id)).toEqual([a.id]);
    const inOrg = await list(w.customer, { organizationId: w.customerOrg.id });
    expect(inOrg.tickets.map((t) => t.id)).toEqual([b.id]);
    const byNumber = await list(w.customer, { q: `#${b.number}` });
    expect(byNumber.tickets.map((t) => t.id)).toEqual([b.id]);
    const bySubject = await list(w.customer, { q: "billing" });
    expect(bySubject.tickets.map((t) => t.id)).toEqual([a.id]);
  });

  it("pages with an opaque cursor; a malformed cursor is 400", async () => {
    const auth2 = createTestAuth({
      staffOrganizationId: STAFF_ORG_ID,
      pageSize: 2,
    });
    const user = await signUpUser(auth2, "pager@acme.test", { verified: true });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { ticket } = await auth2.api.createSupportTicket({
        body: { subject: `T${i}`, body: "x" },
        headers: user.headers,
      });
      ids.push(ticket.id);
    }
    const first = await auth2.api.listMySupportTickets({
      query: {},
      headers: user.headers,
    });
    expect(first.tickets).toHaveLength(2);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await auth2.api.listMySupportTickets({
      query: { cursor: first.nextCursor ?? "" },
      headers: user.headers,
    });
    expect(
      [...first.tickets, ...second.tickets].map((t) => t.id).sort(),
    ).toEqual([...ids].sort());
    expect(second.nextCursor).toBeNull();
    await expect(
      auth2.api.listMySupportTickets({
        query: { cursor: "not a cursor" },
        headers: user.headers,
      }),
    ).rejects.toEqual(error("BAD_REQUEST", SUPPORT_ERROR_CODES.INVALID_CURSOR));
  });

  it("reports features.attachments false without the attachments option", async () => {
    expect((await list(w.customer)).features).toEqual({ attachments: false });
  });

  it("reports features.attachments true with the attachments option", async () => {
    await setup({ attachments: { storage: fakeStorage } });
    expect((await list(w.customer)).features).toEqual({ attachments: true });
  });
});

// ---------------------------------------------------------------------------
// J2: read the reply and answer it
// ---------------------------------------------------------------------------

describe("getSupportTicket and replyToSupportTicket (J2)", () => {
  beforeEach(() => setup());

  it("shows the customer timeline oldest first, never notes or other events", async () => {
    const { ticket } = await create(w.customer, { body: "First" });
    await backdateSeen(ticket.id);
    await agentMessage(ticket.id, {
      kind: "note",
      body: "internal-note-secret",
      mentions: [w.agents.admin.user.id],
    });
    await agentMessage(ticket.id, {
      body: "Agent answer",
      mentions: [w.agents.admin.user.id],
    });
    await insertMessage(auth, {
      ticketId: ticket.id,
      kind: "event",
      authorType: "agent",
      userId: w.agents.member.user.id,
      body: "",
      data: { type: "assignee", from: null, to: w.agents.member.user.id },
      createdAt: new Date(Date.now() + 1000),
    });

    const detail = await get(w.customer, ticket.id);
    expect(detail.ticket).toMatchObject({
      id: ticket.id,
      status: "pending",
      unread: true,
    });
    expect(
      detail.messages.map((m) => [m.kind, m.body, m.data?.type ?? null]),
    ).toEqual([
      ["reply", "First", null],
      ["reply", "Agent answer", null],
      ["event", "", "status"],
    ]);
    expect(detail.messages[0]?.author).toEqual({
      name: "Cora Customer",
      image: null,
    });
    expect(detail.messages[1]).toMatchObject({
      authorType: "agent",
      author: { name: "Agent member", image: null },
    });
    expect(detail.messages[2]?.data).toEqual({
      type: "status",
      from: "open",
      to: "pending",
    });
    expect(detail.attachments).toEqual([]);
    expect(JSON.stringify(detail)).not.toContain("internal-note-secret");
    expectNoHiddenFields(detail);
  });

  it("lets the requester reply; a reply on pending reopens the ticket", async () => {
    const { ticket } = await create(w.customer);
    await agentMessage(ticket.id, { body: "Can you try again?" });
    expect((await row(ticket.id)).status).toBe("pending");

    const { message } = await reply(w.customer, ticket.id, "Still broken");
    expect(message).toMatchObject({
      ticketId: ticket.id,
      kind: "reply",
      authorType: "customer",
      body: "Still broken",
      data: null,
      author: { name: "Cora Customer", image: null },
    });
    expectNoHiddenFields(message);
    const stored = await row(ticket.id);
    expect(stored.status).toBe("open");
    const detail = await get(w.customer, ticket.id);
    expect(detail.ticket.unread).toBe(false);
    expect(detail.messages.at(-2)?.body).toBe("Still broken");
  });

  it("a reply on a solved ticket reopens it", async () => {
    const { ticket } = await create(w.customer);
    await updateMine(w.customer, ticket.id, { status: "solved" });
    await reply(w.customer, ticket.id, "Actually no");
    expect((await row(ticket.id)).status).toBe("open");
  });

  it("refuses a reply on a closed ticket (TICKET_CLOSED), attachments or not", async () => {
    const { ticket } = await create(w.customer);
    await setStatus(ticket.id, "closed");
    await expect(reply(w.customer, ticket.id)).rejects.toEqual(ticketClosed);
    await expect(reply(w.customer, ticket.id, "x", ["att_1"])).rejects.toEqual(
      ticketClosed,
    );
    expect(await messagesOf(ticket.id)).toHaveLength(1);
  });

  it("refuses attachmentIds without the attachments option, and more than 10", async () => {
    const { ticket } = await create(w.customer);
    await expect(
      reply(w.customer, ticket.id, "see file", ["att_1"]),
    ).rejects.toEqual(
      error("BAD_REQUEST", SUPPORT_ERROR_CODES.STORAGE_NOT_CONFIGURED),
    );
    await expect(
      reply(
        w.customer,
        ticket.id,
        "files",
        Array.from({ length: 11 }, (_, i) => `att_${i}`),
      ),
    ).rejects.toEqual(invalidInput);
    expect(await messagesOf(ticket.id)).toHaveLength(1);
    // an empty list is no attachments at all
    await expect(reply(w.customer, ticket.id, "ok", [])).resolves.toBeTruthy();
  });

  it("returns 404 for a missing ticket id", async () => {
    await expect(get(w.customer, "missing")).rejects.toEqual(notFound);
    await expect(reply(w.customer, "missing")).rejects.toEqual(notFound);
    await expect(
      updateMine(w.customer, "missing", { rating: "good" }),
    ).rejects.toEqual(notFound);
    await expect(markSeen(w.customer, "missing")).rejects.toEqual(notFound);
  });

  it("marks the ticket seen for the requester", async () => {
    const { ticket } = await create(w.customer);
    await backdateSeen(ticket.id);
    await agentMessage(ticket.id, { body: "Reply" });
    expect((await get(w.customer, ticket.id)).ticket.unread).toBe(true);
    expect(await markSeen(w.customer, ticket.id)).toEqual({ ok: true });
    expect((await get(w.customer, ticket.id)).ticket.unread).toBe(false);
    expect((await row(ticket.id)).requesterSeenAt).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------
// J3: solve, reopen, rate
// ---------------------------------------------------------------------------

describe("updateMySupportTicket: status and rating (J3)", () => {
  beforeEach(() => setup());

  it("solves and reopens through applyStatus", async () => {
    const { ticket } = await create(w.customer);
    const solved = await updateMine(w.customer, ticket.id, {
      status: "solved",
    });
    expect(solved.ticket.status).toBe("solved");
    expect(solved.ticket.solvedAt).toBeInstanceOf(Date);
    expectNoHiddenFields(solved);

    const reopened = await updateMine(w.customer, ticket.id, {
      status: "open",
    });
    expect(reopened.ticket).toMatchObject({ status: "open", solvedAt: null });

    const events = (await messagesOf(ticket.id)).filter(
      (m) => m.kind === "event",
    );
    expect(events.map((m) => [m.authorType, m.data?.from, m.data?.to])).toEqual(
      expect.arrayContaining([
        ["customer", "open", "solved"],
        ["customer", "solved", "open"],
      ]),
    );
    expect(events).toHaveLength(2);
  });

  it("solves from pending", async () => {
    const { ticket } = await create(w.customer);
    await agentMessage(ticket.id, { body: "Fixed?" });
    const { ticket: t } = await updateMine(w.customer, ticket.id, {
      status: "solved",
    });
    expect(t.status).toBe("solved");
  });

  it("treats the same status as a no-op", async () => {
    const { ticket } = await create(w.customer);
    await updateMine(w.customer, ticket.id, { status: "open" });
    await updateMine(w.customer, ticket.id, { status: "solved" });
    await updateMine(w.customer, ticket.id, { status: "solved" });
    const events = (await messagesOf(ticket.id)).filter(
      (m) => m.kind === "event",
    );
    expect(events).toHaveLength(1);
  });

  it("refuses transitions the rules don't allow (INVALID_STATUS_TRANSITION)", async () => {
    const { ticket } = await create(w.customer);
    await agentMessage(ticket.id, { body: "Waiting on you" });
    // open only from solved
    await expect(
      updateMine(w.customer, ticket.id, { status: "open" }),
    ).rejects.toEqual(badTransition);
    expect((await row(ticket.id)).status).toBe("pending");
  });

  it("refuses any status change on a closed ticket (TICKET_CLOSED) but still takes a rating", async () => {
    const { ticket } = await create(w.customer);
    await setStatus(ticket.id, "closed");
    await expect(
      updateMine(w.customer, ticket.id, { status: "open" }),
    ).rejects.toEqual(ticketClosed);
    await expect(
      updateMine(w.customer, ticket.id, { status: "solved", rating: "good" }),
    ).rejects.toEqual(ticketClosed);
    // nothing was written by the refused request
    expect((await row(ticket.id)).rating ?? null).toBeNull();
    const rated = await updateMine(w.customer, ticket.id, { rating: "bad" });
    expect(rated.ticket).toMatchObject({ status: "closed", rating: "bad" });
  });

  it("refuses statuses a requester can't ask for", async () => {
    const { ticket } = await create(w.customer);
    await expect(
      auth.api.updateMySupportTicket({
        // @ts-expect-error: requesters may only solve or reopen
        body: { id: ticket.id, status: "closed" },
        headers: w.customer.headers,
      }),
    ).rejects.toEqual(invalidInput);
  });

  it("rates good, then bad, at any status", async () => {
    const { ticket } = await create(w.customer);
    const good = await updateMine(w.customer, ticket.id, {
      status: "solved",
      rating: "good",
    });
    expect(good.ticket).toMatchObject({ status: "solved", rating: "good" });
    const bad = await updateMine(w.customer, ticket.id, { rating: "bad" });
    expect(bad.ticket.rating).toBe("bad");
    expect((await row(ticket.id)).rating).toBe("bad");
  });
});

// ---------------------------------------------------------------------------
// J4: share with my organization
// ---------------------------------------------------------------------------

describe("updateMySupportTicket: visibility (J4)", () => {
  beforeEach(() => setup());

  it("shares and unshares; teammates follow the visibility", async () => {
    const { ticket } = await create(w.customer, {
      organizationId: w.customerOrg.id,
    });
    await expect(get(w.teammate, ticket.id)).rejects.toEqual(notFound);
    expect((await list(w.teammate)).tickets).toEqual([]);

    const shared = await updateMine(w.customer, ticket.id, {
      visibility: "organization",
    });
    expect(shared.ticket.visibility).toBe("organization");
    expect((await get(w.teammate, ticket.id)).ticket.id).toBe(ticket.id);
    expect((await list(w.teammate)).tickets.map((t) => t.id)).toEqual([
      ticket.id,
    ]);

    await updateMine(w.customer, ticket.id, { visibility: "private" });
    await expect(get(w.teammate, ticket.id)).rejects.toEqual(notFound);
    expect((await list(w.teammate)).tickets).toEqual([]);
  });

  it("refuses sharing a ticket with no organization (NOT_ALLOWED)", async () => {
    const { ticket } = await create(w.customer);
    await expect(
      updateMine(w.customer, ticket.id, { visibility: "organization" }),
    ).rejects.toEqual(notAllowed);
    expect((await row(ticket.id)).visibility).toBe("private");
  });

  it("needs current membership to share (NOT_A_MEMBER)", async () => {
    const { ticket } = await create(w.teammate, {
      organizationId: w.customerOrg.id,
    });
    await removeMember(auth, {
      organizationId: w.customerOrg.id,
      member: w.teammate,
      by: w.customer,
    });
    await expect(
      updateMine(w.teammate, ticket.id, { visibility: "organization" }),
    ).rejects.toEqual(notAMember);
    expect((await row(ticket.id)).visibility).toBe("private");
  });
});

// ---------------------------------------------------------------------------
// Teammates, outsiders, removed members
// ---------------------------------------------------------------------------

describe("customer access rules", () => {
  beforeEach(() => setup());

  it("a teammate reads and replies on a shared ticket", async () => {
    const ticket = await sharedTicket();
    await backdateSeen(ticket.id);
    const seenBefore = (await row(ticket.id)).requesterSeenAt;
    const detail = await get(w.teammate, ticket.id);
    expect(detail.ticket).toMatchObject({ id: ticket.id, unread: false });

    const { message } = await reply(w.teammate, ticket.id, "Same here");
    expect(message).toMatchObject({
      authorType: "customer",
      author: { name: "Tim Teammate", image: null },
    });
    const stored = (await messagesOf(ticket.id)).find(
      (m) => m.id === message.id,
    );
    expect(stored?.userId).toBe(w.teammate.user.id);
    // the teammate's reply doesn't touch the requester's seen mark
    expect((await row(ticket.id)).requesterSeenAt).toEqual(seenBefore);
    expect((await get(w.customer, ticket.id)).ticket.unread).toBe(true);
  });

  it("a teammate can't solve (update-mine is requester-only)", async () => {
    const ticket = await sharedTicket();
    await expect(
      updateMine(w.teammate, ticket.id, { status: "solved" }),
    ).rejects.toEqual(notAllowed);
    expect((await row(ticket.id)).status).toBe("open");
  });

  it("a teammate can't rate", async () => {
    const ticket = await sharedTicket();
    await expect(
      updateMine(w.teammate, ticket.id, { rating: "good" }),
    ).rejects.toEqual(notAllowed);
    expect((await row(ticket.id)).rating ?? null).toBeNull();
  });

  it("a teammate can't change visibility", async () => {
    const ticket = await sharedTicket();
    await expect(
      updateMine(w.teammate, ticket.id, { visibility: "private" }),
    ).rejects.toEqual(notAllowed);
    expect((await row(ticket.id)).visibility).toBe("organization");
  });

  it("a teammate can't mark seen (mark-seen is requester-only)", async () => {
    const ticket = await sharedTicket();
    await expect(markSeen(w.teammate, ticket.id)).rejects.toEqual(notAllowed);
  });

  it("a teammate gets 404 on a private ticket of the org", async () => {
    const { ticket } = await create(w.customer, {
      organizationId: w.customerOrg.id,
    });
    await expect(get(w.teammate, ticket.id)).rejects.toEqual(notFound);
    await expect(reply(w.teammate, ticket.id)).rejects.toEqual(notFound);
    await expect(
      updateMine(w.teammate, ticket.id, { status: "solved" }),
    ).rejects.toEqual(notFound);
    await expect(markSeen(w.teammate, ticket.id)).rejects.toEqual(notFound);
  });

  it("a non-member gets 404 on every ticket endpoint", async () => {
    const ticket = await sharedTicket();
    await expect(get(w.outsider, ticket.id)).rejects.toEqual(notFound);
    await expect(reply(w.outsider, ticket.id)).rejects.toEqual(notFound);
    await expect(
      updateMine(w.outsider, ticket.id, { rating: "bad" }),
    ).rejects.toEqual(notFound);
    await expect(markSeen(w.outsider, ticket.id)).rejects.toEqual(notFound);
    // an agent is no customer of someone else's ticket either
    await expect(get(w.agents.owner, ticket.id)).rejects.toEqual(notFound);
    expect(await messagesOf(ticket.id)).toHaveLength(1);
  });

  it("a removed teammate loses shared tickets at once (404, not listed)", async () => {
    const ticket = await sharedTicket();
    expect((await get(w.teammate, ticket.id)).ticket.id).toBe(ticket.id);
    await removeMember(auth, {
      organizationId: w.customerOrg.id,
      member: w.teammate,
      by: w.customer,
    });
    await expect(get(w.teammate, ticket.id)).rejects.toEqual(notFound);
    await expect(reply(w.teammate, ticket.id)).rejects.toEqual(notFound);
    expect((await list(w.teammate)).tickets).toEqual([]);
  });

  it("a removed requester keeps their tickets", async () => {
    const { ticket } = await create(w.teammate, {
      organizationId: w.customerOrg.id,
      visibility: "organization",
    });
    await removeMember(auth, {
      organizationId: w.customerOrg.id,
      member: w.teammate,
      by: w.customer,
    });
    expect((await get(w.teammate, ticket.id)).ticket.id).toBe(ticket.id);
    expect((await list(w.teammate)).tickets.map((t) => t.id)).toEqual([
      ticket.id,
    ]);
    await reply(w.teammate, ticket.id, "Still need help");
    await updateMine(w.teammate, ticket.id, {
      status: "solved",
      rating: "good",
    });
    expect(await markSeen(w.teammate, ticket.id)).toEqual({ ok: true });
    // and the org still sees the shared ticket
    expect((await get(w.customer, ticket.id)).ticket.status).toBe("solved");
  });

  it("a new member of the org sees shared tickets", async () => {
    const ticket = await sharedTicket();
    const newcomer = await signUpUser(auth, "new@acme.test", {
      verified: true,
    });
    await expect(get(newcomer, ticket.id)).rejects.toEqual(notFound);
    await addMember(auth, {
      organizationId: w.customerOrg.id,
      userId: newcomer.user.id,
      role: "member",
    });
    expect((await get(newcomer, ticket.id)).ticket.id).toBe(ticket.id);
    const other = await createOrganization(auth, newcomer, { name: "Other" });
    await expect(
      create(w.customer, { organizationId: other.id }),
    ).rejects.toEqual(notAMember);
  });
});

// ---------------------------------------------------------------------------
// The customer serializer is the only output
// ---------------------------------------------------------------------------

describe("customer responses never carry hidden fields", () => {
  beforeEach(() => setup());

  it("create, list, get, reply and update-mine", async () => {
    const created = await create(w.customer, {
      organizationId: w.customerOrg.id,
      visibility: "organization",
    });
    const id = created.ticket.id;
    const { adapter } = await getContext(auth);
    await adapter.update({
      model: "supportTicket",
      where: [{ field: "id", value: id }],
      update: {
        assigneeId: w.agents.member.user.id,
        agentSeenAt: new Date(),
        requesterEmail: "copy@acme.test",
      },
    });
    await agentMessage(id, {
      body: "Answer",
      mentions: [w.agents.admin.user.id],
    });
    await agentMessage(id, { kind: "note", body: "note-secret-body" });
    await insertMessage(auth, {
      ticketId: id,
      kind: "reply",
      authorType: "customer",
      authorEmail: "sender@acme.test",
      authorName: "Mail Sender",
      emailMessageId: "<msg-1@acme.test>",
      channel: "email",
      verified: false,
      body: "By email",
    });
    const stored = await row(id);

    const responses = [
      created,
      await list(w.customer),
      await list(w.teammate),
      await get(w.customer, id),
      await get(w.teammate, id),
      await reply(w.teammate, id, "Me too"),
      await updateMine(w.customer, id, { rating: "good" }),
    ];
    for (const response of responses) {
      expectNoHiddenFields(response);
      const json = JSON.stringify(response);
      expect(json).not.toContain(stored.replyToken);
      expect(json).not.toContain("note-secret-body");
      expect(json).not.toContain("sender@acme.test");
      expect(json).not.toContain("copy@acme.test");
      expect(json).not.toContain(w.agents.member.user.email);
      expect(json).not.toContain(w.agents.member.user.id);
    }
    const detail = await get(w.customer, id);
    const emailed = detail.messages.find((m) => m.body === "By email");
    expect(emailed?.author).toEqual({ name: "Mail Sender", image: null });
    expect(Object.keys(detail.ticket).sort()).toEqual(
      [
        "id",
        "number",
        "subject",
        "status",
        "priority",
        "channel",
        "organizationId",
        "visibility",
        "rating",
        "createdAt",
        "updatedAt",
        "lastMessageAt",
        "solvedAt",
        "unread",
        "isRequester",
      ].sort(),
    );
  });
});

// a world with a second customer org, for org-scoped create checks
describe("create across organizations", () => {
  beforeEach(() => setup());

  it("accepts only the caller's own organizations", async () => {
    const otherOrg = await createOrganization(auth, w.outsider, {
      name: "Elsewhere",
    });
    await expect(
      create(w.customer, { organizationId: otherOrg.id }),
    ).rejects.toEqual(notAMember);
    const { ticket } = await create(w.outsider, {
      organizationId: otherOrg.id,
      visibility: "organization",
    });
    expect(ticket.organizationId).toBe(otherOrg.id);
    expect((await list(w.customer)).tickets).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Merge following (D2): every ticket-id endpoint acts on the resolved ticket
// ---------------------------------------------------------------------------

describe("ticket-id endpoints follow mergedIntoId", () => {
  beforeEach(() => setup());

  /** Marks `source` as merged into `target` (closed), as the merge route will. */
  async function mergeInto(sourceId: string, targetId: string) {
    const { adapter } = await getContext(auth);
    await adapter.update({
      model: "supportTicket",
      where: [{ field: "id", value: sourceId }],
      update: { status: "closed", mergedIntoId: targetId },
    });
  }

  it("get, reply, update-mine and mark-seen on the source act on the target", async () => {
    const source = (await create(w.customer, { subject: "Source" })).ticket;
    const target = (await create(w.customer, { subject: "Target" })).ticket;
    await mergeInto(source.id, target.id);

    const detail = await get(w.customer, source.id);
    expect(detail.ticket).toMatchObject({ id: target.id, subject: "Target" });
    expect(detail.messages.every((m) => m.ticketId === target.id)).toBe(true);

    // the source is closed, the target isn't: the reply lands on the target
    const { message } = await reply(w.customer, source.id, "Follow-up");
    expect(message.ticketId).toBe(target.id);
    expect(await messagesOf(source.id)).toHaveLength(1);

    const rated = await updateMine(w.customer, source.id, {
      status: "solved",
      rating: "good",
    });
    expect(rated.ticket).toMatchObject({
      id: target.id,
      status: "solved",
      rating: "good",
    });
    expect(await row(source.id)).toMatchObject({ status: "closed" });
    expect((await row(source.id)).rating ?? null).toBeNull();

    await backdateSeen(target.id);
    const seenSource = (await row(source.id)).requesterSeenAt;
    await markSeen(w.customer, source.id);
    expect((await row(target.id)).requesterSeenAt?.getTime()).toBeGreaterThan(
      Date.now() - 10_000,
    );
    expect((await row(source.id)).requesterSeenAt).toEqual(seenSource);
  });

  it("re-applies the read rule to the target", async () => {
    const source = await sharedTicket();
    const target = (
      await create(w.customer, {
        subject: "Private target",
        organizationId: w.customerOrg.id,
      })
    ).ticket;
    expect((await get(w.teammate, source.id)).ticket.id).toBe(source.id);
    await mergeInto(source.id, target.id);
    await expect(get(w.teammate, source.id)).rejects.toEqual(notFound);
    await expect(reply(w.teammate, source.id)).rejects.toEqual(notFound);
    await expect(
      updateMine(w.teammate, source.id, { rating: "good" }),
    ).rejects.toEqual(notFound);
    await expect(markSeen(w.teammate, source.id)).rejects.toEqual(notFound);
  });
});
