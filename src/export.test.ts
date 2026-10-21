import { memoryMailer } from "@byo-oss/mailer";
import { describe, expect, it } from "vitest";
import { exportSupportData } from "./export";
import type { SupportOptions, SupportStorage } from "./options";
import type {
  SupportAttachmentRow,
  SupportCannedReplyRow,
  SupportDeliveryRow,
  SupportTicketRow,
} from "./schema";
import {
  type AdapterCall,
  createTestAuth,
  getContext,
  insertMessage,
  insertTag,
  insertTicket,
  signUpUser,
} from "./test-utils";

const email = {
  from: "Support <support@vendor.test>",
  replyDomain: "reply.vendor.test",
  appUrl: "https://app.vendor.test",
};

const storage: SupportStorage = {
  put: async () => {},
  get: async () => null,
  delete: async () => {},
  deletePrefix: async () => {},
};

const withOptionalTables: SupportOptions = {
  mailer: memoryMailer(),
  email,
  attachments: { storage },
};

function setup(opts: SupportOptions = {}) {
  const calls: AdapterCall[] = [];
  const auth = createTestAuth(opts, {
    adapter: { before: (call) => void calls.push(call) },
  });
  return { auth, calls };
}

type Auth = ReturnType<typeof setup>["auth"];

const T0 = new Date("2026-01-01T00:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

async function insertCanned(auth: Auth, userId: string | null) {
  const { adapter } = await getContext(auth);
  return adapter.create<
    Omit<SupportCannedReplyRow, "id">,
    SupportCannedReplyRow
  >({
    model: "supportCannedReply",
    data: {
      title: "Thanks",
      body: "Thanks for writing in.",
      userId,
      createdAt: T0,
      updatedAt: T0,
    },
  });
}

/** Every page of an export, following the cursor. */
async function exportAll(
  auth: Auth,
  options: {
    organizationId?: string;
    limit?: number;
    cursor?: string | null;
  } = {},
) {
  const pages = [];
  let cursor: string | null = options.cursor ?? null;
  do {
    const page = await exportSupportData(auth, { ...options, cursor });
    pages.push(page);
    cursor = page.cursor;
  } while (cursor && pages.length < 50);
  return pages;
}

describe("exportSupportData (PRD #12)", () => {
  it("pages tickets with the cursor, each exactly once", async () => {
    const { auth } = setup();
    const seeded = new Set<string>();
    for (let i = 0; i < 5; i++) seeded.add((await insertTicket(auth)).id);

    const pages = await exportAll(auth, { limit: 2 });
    expect(pages.map((page) => page.tickets.length)).toEqual([2, 2, 1]);
    expect(pages.at(-1)?.cursor).toBeNull();
    const ids = pages.flatMap((page) => page.tickets.map((t) => t.id));
    expect(ids).toHaveLength(5);
    expect(new Set(ids)).toEqual(seeded);
    // number order; the cursor is the last number of the page
    const numbers = pages.flatMap((page) => page.tickets.map((t) => t.number));
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    expect(pages[0]?.cursor).toBe(String(pages[0]?.tickets[1]?.number));
    expect(pages[1]?.cursor).toBe(String(pages[1]?.tickets[1]?.number));
  });

  it("skips nothing when tickets are deleted between pages", async () => {
    const { auth } = setup();
    const seeded: SupportTicketRow[] = [];
    for (let i = 0; i < 6; i++) seeded.push(await insertTicket(auth));
    const ids = [...seeded]
      .sort((a, b) => a.number - b.number)
      .map((t) => t.id);
    const { adapter } = await getContext(auth);
    const remove = (id: string) =>
      adapter.delete({
        model: "supportTicket",
        where: [{ field: "id", value: id }],
      });

    const first = await exportSupportData(auth, { limit: 2 });
    expect(first.tickets.map((t) => t.id)).toEqual(ids.slice(0, 2));
    // one already exported, one not yet reached
    await remove(ids[0] as string);
    await remove(ids[3] as string);
    const rest = await exportAll(auth, { limit: 2, cursor: first.cursor });
    const exported = rest.flatMap((page) => page.tickets.map((t) => t.id));
    expect(exported).toEqual([
      ids[2] as string,
      ids[4] as string,
      ids[5] as string,
    ]);
  });

  it("never exports replyToken", async () => {
    const { auth } = setup();
    for (let i = 0; i < 3; i++) await insertTicket(auth);
    const pages = await exportAll(auth, { limit: 2 });
    const tickets = pages.flatMap((page) => page.tickets);
    expect(tickets).toHaveLength(3);
    for (const ticket of tickets) {
      expect(ticket).not.toHaveProperty("replyToken");
    }
    expect(JSON.stringify(pages)).not.toContain("replyToken");
  });

  it("returns a null cursor when the last page is exactly full, and nothing when empty", async () => {
    const { auth } = setup();
    expect(await exportSupportData(auth)).toEqual({
      tickets: [],
      cannedReplies: [],
      cursor: null,
    });
    for (let i = 0; i < 4; i++) await insertTicket(auth);
    const pages = await exportAll(auth, { limit: 2 });
    expect(pages.map((page) => page.tickets.length)).toEqual([2, 2]);
    expect(pages.at(-1)?.cursor).toBeNull();
  });

  it("filters by organization, and leaves canned replies out of an organization export", async () => {
    const { auth } = setup();
    const a1 = await insertTicket(auth, { organizationId: "org_a" });
    const a2 = await insertTicket(auth, { organizationId: "org_a" });
    await insertTicket(auth, { organizationId: "org_b" });
    await insertTicket(auth);
    await insertCanned(auth, null);

    const pages = await exportAll(auth, { organizationId: "org_a", limit: 1 });
    const ids = pages.flatMap((page) => page.tickets.map((t) => t.id));
    expect(ids.sort()).toEqual([a1.id, a2.id].sort());
    for (const page of pages) {
      expect(page.cannedReplies).toEqual([]);
      for (const ticket of page.tickets) {
        expect(ticket.organizationId).toBe("org_a");
      }
    }
  });

  it("returns every canned reply on the first page of a whole export only", async () => {
    const { auth } = setup();
    for (let i = 0; i < 3; i++) await insertTicket(auth);
    await insertCanned(auth, null);
    await insertCanned(auth, null);

    const pages = await exportAll(auth, { limit: 1 });
    expect(pages.map((page) => page.cannedReplies.length)).toEqual([2, 0, 0]);
    expect(pages[0]?.cannedReplies[0]).toMatchObject({
      title: "Thanks",
      createdAt: T0.toISOString(),
      userEmail: null,
    });
  });

  it("exports tags, messages oldest first, and dates as ISO strings", async () => {
    const { auth } = setup();
    const ticket = await insertTicket(auth, {
      channel: "email",
      requesterEmail: "pat@example.test",
      requesterName: "Pat",
      createdAt: T0,
      updatedAt: T0,
      lastMessageAt: T0,
    });
    await insertTag(auth, { ticketId: ticket.id, tag: "billing" });
    await insertTag(auth, { ticketId: ticket.id, tag: "api" });
    const second = await insertMessage(auth, {
      ticketId: ticket.id,
      body: "second",
      createdAt: at(2),
    });
    const note = await insertMessage(auth, {
      ticketId: ticket.id,
      kind: "note",
      authorType: "agent",
      body: "internal",
      createdAt: at(3),
    });
    const first = await insertMessage(auth, {
      ticketId: ticket.id,
      body: "first",
      authorEmail: "pat@example.test",
      createdAt: at(1),
    });

    const { tickets } = await exportSupportData(auth);
    expect(tickets).toHaveLength(1);
    const [exported] = tickets;
    expect(exported).toMatchObject({
      id: ticket.id,
      number: ticket.number,
      requesterEmail: "pat@example.test",
      requesterName: "Pat",
      createdAt: T0.toISOString(),
      lastMessageAt: T0.toISOString(),
      userEmail: null,
      assigneeEmail: null,
      tags: ["api", "billing"],
      attachments: [],
    });
    expect(exported?.messages.map((m) => m.id)).toEqual([
      first.id,
      second.id,
      note.id,
    ]);
    expect(exported?.messages[0]).toMatchObject({
      body: "first",
      authorEmail: "pat@example.test",
      createdAt: at(1).toISOString(),
      userEmail: null,
      deliveries: [],
    });
    // plain JSON: survives a round trip unchanged
    expect(JSON.parse(JSON.stringify(tickets))).toEqual(tickets);
  });

  it("puts the user's current email on every row with a user id", async () => {
    const { auth } = setup(withOptionalTables);
    const requester = await signUpUser(auth, "req@example.test");
    const agent = await signUpUser(auth, "agent@vendor.test");
    const writer = await signUpUser(auth, "writer@vendor.test");
    const ticket = await insertTicket(auth, {
      userId: requester.user.id,
      assigneeId: agent.user.id,
    });
    const customerMessage = await insertMessage(auth, {
      ticketId: ticket.id,
      userId: requester.user.id,
    });
    const agentMessage = await insertMessage(auth, {
      ticketId: ticket.id,
      authorType: "agent",
      userId: agent.user.id,
      createdAt: at(10),
    });
    const { adapter } = await getContext(auth);
    await adapter.create<Omit<SupportAttachmentRow, "id">>({
      model: "supportAttachment",
      data: {
        ticketId: ticket.id,
        messageId: customerMessage.id,
        userId: requester.user.id,
        internal: false,
        filename: "screen.png",
        contentType: "image/png",
        size: 10,
        storageKey: "support/_/att_1",
        createdAt: T0,
      },
    });
    await insertCanned(auth, writer.user.id);
    // emails change; the export carries the current one
    const context = await getContext(auth);
    await context.internalAdapter.updateUser(requester.user.id, {
      email: "req-new@example.test",
    });

    const page = await exportSupportData(auth);
    const [exported] = page.tickets;
    expect(exported?.userEmail).toBe("req-new@example.test");
    expect(exported?.assigneeEmail).toBe("agent@vendor.test");
    const byId = new Map(exported?.messages.map((m) => [m.id, m]));
    expect(byId.get(customerMessage.id)?.userEmail).toBe(
      "req-new@example.test",
    );
    expect(byId.get(agentMessage.id)?.userEmail).toBe("agent@vendor.test");
    expect(exported?.attachments[0]?.userEmail).toBe("req-new@example.test");
    expect(page.cannedReplies[0]?.userEmail).toBe("writer@vendor.test");
  });

  it("includes deliveries and attachment metadata only when their tables exist", async () => {
    // without mailer and attachments: those tables don't exist and aren't read
    const plain = setup();
    const t1 = await insertTicket(plain.auth);
    await insertMessage(plain.auth, { ticketId: t1.id });
    plain.calls.length = 0;
    const [bare] = (await exportSupportData(plain.auth)).tickets;
    expect(bare?.attachments).toEqual([]);
    expect(bare?.messages[0]?.deliveries).toEqual([]);
    const models = new Set(plain.calls.map((call) => call.model));
    expect(models.has("supportDelivery")).toBe(false);
    expect(models.has("supportAttachment")).toBe(false);

    // with both
    const full = setup(withOptionalTables);
    const t2 = await insertTicket(full.auth);
    const message = await insertMessage(full.auth, {
      ticketId: t2.id,
      authorType: "agent",
    });
    const { adapter } = await getContext(full.auth);
    await adapter.create<Omit<SupportDeliveryRow, "id">>({
      model: "supportDelivery",
      data: {
        messageId: message.id,
        ticketId: t2.id,
        status: "sent",
        scheduledFor: T0,
        attempts: 1,
        providerId: "prov_1",
        createdAt: T0,
      },
    });
    await adapter.create<Omit<SupportAttachmentRow, "id">>({
      model: "supportAttachment",
      data: {
        ticketId: t2.id,
        messageId: message.id,
        internal: true,
        filename: "log.txt",
        contentType: "text/plain",
        size: 3,
        storageKey: "support/_/att_2",
        createdAt: T0,
      },
    });
    const [withAll] = (await exportSupportData(full.auth)).tickets;
    const delivery = withAll?.messages[0]?.deliveries[0];
    expect(delivery).toMatchObject({
      status: "sent",
      attempts: 1,
      providerId: "prov_1",
      scheduledFor: T0.toISOString(),
      createdAt: T0.toISOString(),
    });
    expect(delivery).not.toHaveProperty("messageId");
    expect(delivery).not.toHaveProperty("ticketId");
    expect(withAll?.attachments).toEqual([
      expect.objectContaining({
        filename: "log.txt",
        storageKey: "support/_/att_2",
        internal: true,
        createdAt: T0.toISOString(),
        userEmail: null,
      }),
    ]);
  });

  it("leaves supportCounter out", async () => {
    const { auth, calls } = setup(withOptionalTables);
    for (let i = 0; i < 3; i++) await insertTicket(auth);
    await insertCanned(auth, null);
    // insertTicket allocates numbers through the counter; only the export counts
    calls.length = 0;
    const pages = await exportAll(auth, { limit: 2 });
    expect(calls.some((call) => call.model === "supportCounter")).toBe(false);
    for (const page of pages) {
      expect(Object.keys(page).sort()).toEqual([
        "cannedReplies",
        "cursor",
        "tickets",
      ]);
    }
  });

  it("refuses a bad limit, an empty organizationId and a malformed cursor", async () => {
    const { auth } = setup();
    for (const limit of [0, 501, 1.5]) {
      await expect(exportSupportData(auth, { limit })).rejects.toThrow(
        "[@byo-oss/support] exportSupportData: limit must be an integer from 1 to 500",
      );
    }
    await expect(
      exportSupportData(auth, { organizationId: "" }),
    ).rejects.toThrow(
      "[@byo-oss/support] exportSupportData: organizationId is empty",
    );
    for (const cursor of ["abc", "-1", "1.5", "01"]) {
      await expect(exportSupportData(auth, { cursor })).rejects.toThrow(
        "[@byo-oss/support] exportSupportData: invalid cursor",
      );
    }
  });

  it("throws without the support plugin", async () => {
    const auth = { $context: Promise.resolve({ options: { plugins: [] } }) };
    await expect(exportSupportData(auth)).rejects.toThrow(
      "[@byo-oss/support] exportSupportData needs the support plugin installed on this auth instance",
    );
  });
});
