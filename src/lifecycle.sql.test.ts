// PRD acceptance #10: lifecycle on a real SQL database (PGlite, foreign keys on).
import { memoryMailer } from "@byo-oss/mailer";
import { afterEach, describe, expect, it } from "vitest";
import {
  deleteOrganizationData,
  deleteSupportRequesterData,
} from "./lifecycle";
import type { SupportOptions, SupportStorage } from "./options";
import type {
  SupportAttachmentRow,
  SupportCannedReplyRow,
  SupportDeliveryRow,
  SupportMessageRow,
  SupportTicketRow,
  SupportTicketTagRow,
} from "./schema";
import { createSqlTestAuth } from "./test-sql";
import {
  getContext,
  insertMessage,
  insertTag,
  insertTicket,
  removeMember,
  STAFF_ORG_ID,
  seedSupportWorld,
  signUpUser,
} from "./test-utils";

const EMAIL = {
  from: "Support <support@vendor.test>",
  replyDomain: "reply.vendor.test",
  appUrl: "https://app.vendor.test",
};
const PAT = "pat@example.test";
const HOUR = 60 * 60_000;

type Harness = Awaited<ReturnType<typeof createSqlTestAuth>>;
let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

/** A spy `SupportStorage` (G16: not the `./testing` memory storage). */
function spyStorage() {
  const blobs = new Map<string, Uint8Array>();
  const calls: string[] = [];
  const storage: SupportStorage = {
    put: async ({ key, body }) => {
      blobs.set(key, body);
    },
    get: async () => null,
    delete: async (key) => {
      calls.push(`delete ${key}`);
      blobs.delete(key);
    },
    deletePrefix: async (prefix) => {
      calls.push(`deletePrefix ${prefix}`);
      for (const key of [...blobs.keys()]) {
        if (key.startsWith(prefix)) blobs.delete(key);
      }
    },
  };
  return { storage, calls, keys: () => [...blobs.keys()].sort() };
}

async function setup(opts: SupportOptions = {}) {
  const { storage, calls, keys } = spyStorage();
  harness = await createSqlTestAuth({
    staffOrganizationId: STAFF_ORG_ID,
    mailer: memoryMailer(),
    email: EMAIL,
    attachments: { storage },
    ...opts,
  });
  const { auth, db } = harness;
  const world = await seedSupportWorld(auth);
  return { auth, db, world, storage, calls, keys };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** A ticket with a row in every child table and a blob under its org prefix. */
async function seedTicket(
  s: Setup,
  overrides: Partial<Omit<SupportTicketRow, "id">> = {},
) {
  const { adapter } = await getContext(s.auth);
  const ticket = await insertTicket(s.auth, overrides);
  const message = await insertMessage(s.auth, {
    ticketId: ticket.id,
    authorType: "agent",
    userId: s.world.agents.admin.user.id,
  });
  await insertTag(s.auth, { ticketId: ticket.id, tag: "billing" });
  await adapter.create({
    model: "supportDelivery",
    data: {
      messageId: message.id,
      ticketId: ticket.id,
      status: "pending",
      scheduledFor: new Date(Date.now() + HOUR),
      attempts: 0,
      createdAt: new Date(),
    },
  });
  const storageKey = `support/${ticket.organizationId ?? "_"}/${crypto.randomUUID()}`;
  await s.storage.put({
    key: storageKey,
    body: new Uint8Array([1]),
    contentType: "image/png",
  });
  await adapter.create({
    model: "supportAttachment",
    data: {
      ticketId: ticket.id,
      messageId: message.id,
      userId: s.world.agents.admin.user.id,
      internal: false,
      filename: "shot.png",
      contentType: "image/png",
      size: 1,
      storageKey,
      createdAt: new Date(),
    },
  });
  return { ticket, message, storageKey };
}

/** Every support row, read with raw SQL. */
async function snapshot(s: Setup) {
  const all = <T>(table: string) =>
    s.db.selectFrom(table).selectAll().execute() as Promise<T[]>;
  const tickets = await all<SupportTicketRow>("supportTicket");
  return {
    tickets,
    messages: await all<SupportMessageRow>("supportMessage"),
    tags: await all<SupportTicketTagRow>("supportTicketTag"),
    deliveries: await all<SupportDeliveryRow>("supportDelivery"),
    attachments: await all<SupportAttachmentRow>("supportAttachment"),
    canned: await all<SupportCannedReplyRow>("supportCannedReply"),
    ticket: (id: string) => tickets.find((t) => t.id === id),
  };
}

// migrating and seeding PGlite takes seconds, more when files run side by side
describe("lifecycle on PGlite", { timeout: 30_000 }, () => {
  it("user delete nulls userId and assigneeId and leaves no copy of their email", async () => {
    const s = await setup();
    const { adapter, internalAdapter } = await getContext(s.auth);
    const agent = s.world.agents.admin;
    const pat = await signUpUser(s.auth, PAT, { name: "Pat" });
    const own = await seedTicket(s, {
      userId: pat.user.id,
      assigneeId: agent.user.id,
    });
    await insertMessage(s.auth, {
      ticketId: own.ticket.id,
      userId: pat.user.id,
    });
    const emailed = await insertTicket(s.auth, {
      channel: "email",
      requesterEmail: PAT,
      requesterName: "Pat",
      verified: false,
    });
    const quoted = await insertMessage(s.auth, {
      ticketId: emailed.id,
      channel: "email",
      authorEmail: PAT,
      authorName: "Pat",
    });
    await adapter.create({
      model: "supportCannedReply",
      data: {
        title: "Hi",
        body: "Hello there",
        userId: agent.user.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    await internalAdapter.deleteUser(pat.user.id);
    await internalAdapter.deleteUser(agent.user.id);

    const after = await snapshot(s);
    const gone = new Set([pat.user.id, agent.user.id]);
    for (const row of [
      ...after.tickets,
      ...after.messages,
      ...after.canned,
      ...after.attachments,
    ]) {
      expect(gone.has(row.userId ?? "")).toBe(false);
    }
    expect(after.ticket(own.ticket.id)).toMatchObject({
      userId: null,
      assigneeId: null,
    });
    expect(after.ticket(emailed.id)).toMatchObject({
      requesterEmail: null,
      requesterName: null,
    });
    expect(after.messages.find((m) => m.id === quoted.id)).toMatchObject({
      authorEmail: null,
      authorName: null,
    });
    // set null, not cascade: the history stays
    expect(after.tickets).toHaveLength(2);
    expect(after.canned).toHaveLength(1);
    expect(after.attachments).toHaveLength(1);
    expect(JSON.stringify(after)).not.toContain(PAT);
  });

  it("user delete removes their id from mentions and assignee events (no foreign key reaches json)", async () => {
    const s = await setup();
    const { internalAdapter } = await getContext(s.auth);
    const gone = s.world.agents.admin.user.id;
    const kept = s.world.agents.member.user.id;
    const { ticket } = await seedTicket(s, { assigneeId: kept });
    const agentRow = (overrides: Partial<SupportMessageRow>) =>
      insertMessage(s.auth, {
        ticketId: ticket.id,
        authorType: "agent",
        userId: kept,
        ...overrides,
      });
    const only = await agentRow({ kind: "note", mentions: [gone] });
    const both = await agentRow({ kind: "reply", mentions: [gone, kept] });
    const assignee = await agentRow({
      kind: "event",
      body: "",
      data: { type: "assignee", from: gone, to: kept },
    });
    const status = await agentRow({
      kind: "event",
      body: "",
      data: { type: "status", from: "open", to: "pending" },
    });

    await internalAdapter.deleteUser(gone);

    const after = await snapshot(s);
    const message = (id: string) => after.messages.find((m) => m.id === id);
    expect(message(only.id)?.mentions ?? null).toBeNull();
    expect(message(both.id)?.mentions).toEqual([kept]);
    expect(message(assignee.id)?.data).toEqual({
      type: "assignee",
      from: null,
      to: kept,
    });
    expect(message(status.id)?.data).toEqual({
      type: "status",
      from: "open",
      to: "pending",
    });
    expect(JSON.stringify(after.messages)).not.toContain(gone);
  });

  it.each([
    { cleanup: "organizationCleanup on", organizationCleanup: true },
    { cleanup: "organizationCleanup: false", organizationCleanup: false },
  ])(
    "org delete through the org plugin removes rows by cascade and blobs by prefix ($cleanup)",
    async ({ organizationCleanup }) => {
      const s = await setup({ organizationCleanup });
      const orgId = s.world.customerOrg.id;
      const target = await seedTicket(s, { organizationId: orgId });
      await seedTicket(s, { organizationId: orgId });
      // a merge needs the same organization, so the merged source goes with
      // the cascade too: no foreign key on mergedIntoId has to null it
      await insertTicket(s.auth, {
        organizationId: orgId,
        mergedIntoId: target.ticket.id,
      });
      const orgless = await seedTicket(s);
      const orglessMerged = await insertTicket(s.auth, {
        mergedIntoId: orgless.ticket.id,
      });

      await s.auth.api.deleteOrganization({
        body: { organizationId: orgId },
        headers: s.world.customer.headers,
      });

      const after = await snapshot(s);
      expect(after.tickets.map((t) => t.id).sort()).toEqual(
        [orgless.ticket.id, orglessMerged.id].sort(),
      );
      // nothing left points at a ticket that's gone
      const ids = new Set(after.tickets.map((t) => t.id));
      for (const ticket of after.tickets) {
        if (ticket.mergedIntoId)
          expect(ids.has(ticket.mergedIntoId)).toBe(true);
      }
      expect(after.ticket(orglessMerged.id)?.mergedIntoId).toBe(
        orgless.ticket.id,
      );
      expect(after.messages).toHaveLength(1);
      expect(after.tags).toHaveLength(1);
      expect(after.deliveries).toHaveLength(1);
      expect(after.attachments).toHaveLength(1);
      // the cascade removed the rows before the hook ran, so the prefix is
      // what reached the blobs
      expect(s.calls).toEqual([`deletePrefix support/${orgId}/`]);
      expect(s.keys()).toEqual([orgless.storageKey]);

      // safe to run again after the cascade
      expect(await deleteOrganizationData(s.auth, orgId)).toEqual({
        tickets: 0,
      });
    },
  );

  it("removing a staff member unassigns their tickets", async () => {
    const s = await setup();
    const removed = s.world.agents.readOnly;
    const ticket = await insertTicket(s.auth, { assigneeId: removed.user.id });
    const kept = await insertTicket(s.auth, {
      assigneeId: s.world.agents.admin.user.id,
    });

    await removeMember(s.auth, {
      organizationId: STAFF_ORG_ID,
      member: removed,
      by: s.world.agents.owner,
    });

    const after = await snapshot(s);
    expect(after.ticket(ticket.id)?.assigneeId).toBeNull();
    expect(after.ticket(kept.id)?.assigneeId).toBe(
      s.world.agents.admin.user.id,
    );
  });

  it("deleteSupportRequesterData deletes their tickets and anonymizes their messages", async () => {
    const s = await setup();
    const first = await seedTicket(s, {
      channel: "email",
      requesterEmail: PAT,
    });
    const merged = await insertTicket(s.auth, {
      mergedIntoId: first.ticket.id,
    });
    const other = await seedTicket(s, { userId: s.world.customer.user.id });
    const cc = await insertMessage(s.auth, {
      ticketId: other.ticket.id,
      channel: "email",
      authorEmail: PAT,
      authorName: "Pat",
    });

    expect(await deleteSupportRequesterData(s.auth, { email: PAT })).toEqual({
      tickets: 1,
      messages: 1,
    });

    const after = await snapshot(s);
    expect(after.tickets.map((t) => t.id).sort()).toEqual(
      [merged.id, other.ticket.id].sort(),
    );
    expect(after.ticket(merged.id)?.mergedIntoId).toBeNull();
    expect(after.messages.find((m) => m.id === cc.id)).toMatchObject({
      authorEmail: null,
      authorName: null,
    });
    expect(JSON.stringify(after)).not.toContain(PAT);
    expect(s.keys()).toEqual([other.storageKey]);
  });

  it("deleteSupportTickets deletes children first, so foreign keys never refuse it", async () => {
    const s = await setup();
    const one = await seedTicket(s);
    const kept = await seedTicket(s);
    const merged = await insertTicket(s.auth, { mergedIntoId: one.ticket.id });

    expect(
      await s.auth.api.deleteSupportTickets({
        body: { ids: [one.ticket.id] },
        headers: s.world.agents.admin.headers,
      }),
    ).toEqual({ deleted: 1 });

    const after = await snapshot(s);
    expect(after.tickets.map((t) => t.id).sort()).toEqual(
      [kept.ticket.id, merged.id].sort(),
    );
    expect(after.ticket(merged.id)?.mergedIntoId).toBeNull();
    expect(after.messages).toHaveLength(1);
    expect(s.calls).toEqual([`delete ${one.storageKey}`]);
    expect(s.keys()).toEqual([kept.storageKey]);
  });
});
