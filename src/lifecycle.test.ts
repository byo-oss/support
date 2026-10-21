import { runWithTransaction } from "@better-auth/core/context";
import {
  deleteMemberData as coreDeleteMemberData,
  deleteOrganizationData as coreDeleteOrganizationData,
  sweepAll,
} from "@byo-oss/core";
import { memoryMailer } from "@byo-oss/mailer";
import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware, isAPIError } from "better-auth/api";
import { describe, expect, it } from "vitest";
import { SUPPORT_ERROR_CODES } from "./error-codes";
import {
  deleteMemberData,
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
import {
  type AnyTestAuth,
  addMember,
  createOrganization,
  createTestAuth,
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

/**
 * A spy `SupportStorage` (G16: not the `./testing` memory storage). Every
 * call lands in `log`, shared with the adapter trace so order can be checked.
 */
function spyStorage(log: string[]) {
  const blobs = new Map<string, Uint8Array>();
  const storage: SupportStorage = {
    put: async ({ key, body }) => {
      blobs.set(key, body);
    },
    get: async () => null,
    delete: async (key) => {
      log.push(`storage.delete ${key}`);
      blobs.delete(key);
    },
    deletePrefix: async (prefix) => {
      log.push(`storage.deletePrefix ${prefix}`);
      for (const key of [...blobs.keys()]) {
        if (key.startsWith(prefix)) blobs.delete(key);
      }
    },
  };
  return { storage, keys: () => [...blobs.keys()].sort() };
}

/** Records the `returned` value every org endpoint hands to after-hooks. */
function probePlugin(seen: unknown[]): BetterAuthPlugin {
  return {
    id: "probe",
    hooks: {
      after: [
        {
          matcher: (ctx) => !!ctx.path?.startsWith("/organization/"),
          handler: createAuthMiddleware(async (ctx) => {
            seen.push(ctx.context.returned);
          }),
        },
      ],
    },
  };
}

async function setup(opts: SupportOptions = {}) {
  const log: string[] = [];
  const seen: unknown[] = [];
  const { storage, keys } = spyStorage(log);
  const auth = createTestAuth(
    {
      staffOrganizationId: STAFF_ORG_ID,
      mailer: memoryMailer(),
      email: EMAIL,
      attachments: { storage },
      ...opts,
    },
    {
      plugins: [probePlugin(seen)],
      adapter: {
        before: ({ method, model }) => {
          if (method === "deleteMany" || method === "updateMany") {
            log.push(`${method} ${model}`);
          }
        },
      },
    },
  );
  const world = await seedSupportWorld(auth);
  return { auth, world, storage, keys, log, seen };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/**
 * A ticket with one row in every child table: an agent reply, a tag, a
 * pending delivery of that reply, and an attachment whose blob is stored
 * under the ticket's org prefix.
 */
async function seedTicket(
  s: Setup,
  overrides: Partial<Omit<SupportTicketRow, "id">> = {},
) {
  const context = await getContext(s.auth);
  const ticket = await insertTicket(s.auth, overrides);
  const message = await insertMessage(s.auth, {
    ticketId: ticket.id,
    kind: "reply",
    authorType: "agent",
    userId: s.world.agents.admin.user.id,
  });
  await insertTag(s.auth, { ticketId: ticket.id, tag: "billing" });
  await context.adapter.create({
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
    body: new Uint8Array([1, 2, 3]),
    contentType: "image/png",
  });
  await context.adapter.create({
    model: "supportAttachment",
    data: {
      ticketId: ticket.id,
      messageId: message.id,
      userId: s.world.agents.admin.user.id,
      internal: false,
      filename: "shot.png",
      contentType: "image/png",
      size: 3,
      storageKey,
      createdAt: new Date(),
    },
  });
  return { ticket, message, storageKey };
}

const MAX_ROWS = 10_000;

/** Every support row, plus whatever references something that's gone. */
async function snapshot(auth: AnyTestAuth) {
  const { adapter } = await getContext(auth);
  const all = <T>(model: string) =>
    adapter.findMany<T>({ model, where: [], limit: MAX_ROWS });
  const tickets = await all<SupportTicketRow>("supportTicket");
  const messages = await all<SupportMessageRow>("supportMessage");
  const tags = await all<SupportTicketTagRow>("supportTicketTag");
  const deliveries = await all<SupportDeliveryRow>("supportDelivery");
  const attachments = await all<SupportAttachmentRow>("supportAttachment");
  const canned = await all<SupportCannedReplyRow>("supportCannedReply");
  const ticketIds = new Set(tickets.map((t) => t.id));
  const messageIds = new Set(messages.map((m) => m.id));
  const orphans = [
    ...[...messages, ...tags, ...deliveries, ...attachments]
      .filter((row) => !ticketIds.has(row.ticketId))
      .map((row) => `ticketId ${row.ticketId}`),
    ...[...deliveries, ...attachments]
      .filter((row) => row.messageId && !messageIds.has(row.messageId))
      .map((row) => `messageId ${row.messageId}`),
    ...tickets
      .filter((t) => t.mergedIntoId && !ticketIds.has(t.mergedIntoId))
      .map((t) => `mergedIntoId ${t.mergedIntoId}`),
  ];
  return {
    tickets,
    messages,
    tags,
    deliveries,
    attachments,
    canned,
    orphans,
    ticket: (id: string) => tickets.find((t) => t.id === id),
  };
}

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

describe("user delete without foreign keys", () => {
  it("nulls the user's ids everywhere and clears copies of their email", async () => {
    const s = await setup();
    const context = await getContext(s.auth);
    const agent = s.world.agents.admin;
    // unverified, so nothing links their address to the account
    const pat = await signUpUser(s.auth, PAT, { name: "Pat" });

    const own = await seedTicket(s, { userId: pat.user.id });
    await context.adapter.update({
      model: "supportTicket",
      where: [{ field: "id", value: own.ticket.id }],
      update: { assigneeId: agent.user.id },
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
    const other = await insertTicket(s.auth, {
      userId: s.world.customer.user.id,
    });
    const quoted = await insertMessage(s.auth, {
      ticketId: other.id,
      channel: "email",
      authorEmail: PAT,
      authorName: "Pat",
    });
    await context.adapter.create({
      model: "supportCannedReply",
      data: {
        title: "Hi",
        body: "Hello there",
        userId: agent.user.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    const before = await snapshot(s.auth);

    await context.internalAdapter.deleteUser(pat.user.id);
    await context.internalAdapter.deleteUser(agent.user.id);

    const after = await snapshot(s.auth);
    const gone = new Set([pat.user.id, agent.user.id]);
    for (const row of [
      ...after.tickets,
      ...after.messages,
      ...after.canned,
      ...after.attachments,
    ]) {
      expect(gone.has(row.userId ?? "")).toBe(false);
    }
    expect(after.tickets.some((t) => t.assigneeId === agent.user.id)).toBe(
      false,
    );
    expect(JSON.stringify(after)).not.toContain(PAT);
    // anonymized, not deleted
    expect(after.tickets).toHaveLength(before.tickets.length);
    expect(after.messages).toHaveLength(before.messages.length);
    expect(after.canned).toHaveLength(1);
    expect(after.ticket(emailed.id)).toMatchObject({
      requesterEmail: null,
      requesterName: null,
    });
    expect(after.messages.find((m) => m.id === quoted.id)).toMatchObject({
      authorEmail: null,
      authorName: null,
      body: "Hello",
    });
    expect(after.ticket(other.id)?.userId).toBe(s.world.customer.user.id);
    expect(after.orphans).toEqual([]);
  });

  it("shows a deleted agent's tickets under assignee: none", async () => {
    const s = await setup();
    const context = await getContext(s.auth);
    const agent = s.world.agents.member;
    const ticket = await insertTicket(s.auth, { assigneeId: agent.user.id });
    const headers = s.world.agents.owner.headers;
    const list = (assignee: string) =>
      s.auth.api.listSupportTickets({ query: { assignee }, headers });
    expect((await list("none")).tickets.map((t) => t.id)).not.toContain(
      ticket.id,
    );

    await context.internalAdapter.deleteUser(agent.user.id);

    expect((await list("none")).tickets.map((t) => t.id)).toContain(ticket.id);
    expect((await list(agent.user.id)).tickets).toHaveLength(0);
  });
});

describe("organization cleanup through the org plugin", () => {
  it("deleting an organization removes its tickets, every child row and its blobs", async () => {
    const s = await setup();
    const orgId = s.world.customerOrg.id;
    const globex = await createOrganization(s.auth, s.world.outsider, {
      name: "Globex",
    });
    const a = await seedTicket(s, { organizationId: orgId });
    await seedTicket(s, { organizationId: orgId });
    const elsewhere = await seedTicket(s, { organizationId: globex.id });
    const orgless = await seedTicket(s);
    // merged into one of the org's tickets: must not dangle afterwards
    const merged = await insertTicket(s.auth, { mergedIntoId: a.ticket.id });
    // a blob with no row (an upload in flight) still goes with the prefix
    await s.storage.put({
      key: `support/${orgId}/stray`,
      body: new Uint8Array([9]),
      contentType: "image/png",
    });

    const org = await s.auth.api.deleteOrganization({
      body: { organizationId: orgId },
      headers: s.world.customer.headers,
    });
    expect(org).toMatchObject({ id: orgId });

    const after = await snapshot(s.auth);
    expect(after.tickets.filter((t) => t.organizationId === orgId)).toEqual([]);
    expect(after.tickets).toHaveLength(3);
    expect(after.ticket(merged.id)?.mergedIntoId ?? null).toBeNull();
    expect(after.orphans).toEqual([]);
    expect(after.messages).toHaveLength(2);
    expect(after.deliveries).toHaveLength(2);
    expect(after.attachments).toHaveLength(2);
    expect(s.keys()).toEqual([elsewhere.storageKey, orgless.storageKey].sort());
    expect(s.log).toContain(`storage.deletePrefix support/${orgId}/`);
  });

  it("leaving the staff organization unassigns the leaver's tickets", async () => {
    const s = await setup();
    const leaver = s.world.agents.member;
    const mine = await insertTicket(s.auth, { assigneeId: leaver.user.id });
    const theirs = await insertTicket(s.auth, {
      assigneeId: s.world.agents.admin.user.id,
    });

    await s.auth.api.leaveOrganization({
      body: { organizationId: STAFF_ORG_ID },
      headers: leaver.headers,
    });

    const after = await snapshot(s.auth);
    expect(after.ticket(mine.id)?.assigneeId ?? null).toBeNull();
    expect(after.ticket(theirs.id)?.assigneeId).toBe(
      s.world.agents.admin.user.id,
    );
  });

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

    const after = await snapshot(s.auth);
    expect(after.ticket(ticket.id)?.assigneeId ?? null).toBeNull();
    expect(after.ticket(kept.id)?.assigneeId).toBe(
      s.world.agents.admin.user.id,
    );
  });

  it("leaving or being removed from a customer organization changes nothing", async () => {
    const s = await setup();
    const orgId = s.world.customerOrg.id;
    const { teammate, outsider, customer } = s.world;
    await addMember(s.auth, {
      organizationId: orgId,
      userId: outsider.user.id,
      role: "member",
    });
    const shared = await insertTicket(s.auth, {
      organizationId: orgId,
      visibility: "organization",
      userId: teammate.user.id,
      assigneeId: teammate.user.id,
    });
    const other = await insertTicket(s.auth, {
      organizationId: orgId,
      userId: outsider.user.id,
      assigneeId: outsider.user.id,
    });
    const before = await snapshot(s.auth);

    await s.auth.api.leaveOrganization({
      body: { organizationId: orgId },
      headers: teammate.headers,
    });
    await removeMember(s.auth, {
      organizationId: orgId,
      member: outsider,
      by: customer,
    });

    const after = await snapshot(s.auth);
    expect(after.ticket(shared.id)).toEqual(before.ticket(shared.id));
    expect(after.ticket(other.id)).toEqual(before.ticket(other.id));
  });

  it("leaves tickets and blobs untouched when the org endpoint fails", async () => {
    const s = await setup();
    const orgId = s.world.customerOrg.id;
    await seedTicket(s, { organizationId: orgId });
    const assigned = await insertTicket(s.auth, {
      assigneeId: s.world.agents.admin.user.id,
    });
    const before = await snapshot(s.auth);
    const keys = s.keys();
    s.seen.length = 0;

    // a plain member may not delete the org
    await expect(
      s.auth.api.deleteOrganization({
        body: { organizationId: orgId },
        headers: s.world.teammate.headers,
      }),
    ).rejects.toEqual(failsWith("FORBIDDEN"));
    // no session at all
    await expect(
      s.auth.api.deleteOrganization({
        body: { organizationId: orgId },
        headers: new Headers(),
      }),
    ).rejects.toEqual(failsWith("UNAUTHORIZED"));
    // billing may not remove members
    await expect(
      removeMember(s.auth, {
        organizationId: STAFF_ORG_ID,
        member: s.world.agents.admin,
        by: s.world.agents.billing,
      }),
    ).rejects.toThrow();

    // the after-hooks did run, each with the endpoint's error as `returned`
    expect(s.seen).toHaveLength(3);
    expect(s.seen.every((returned) => isAPIError(returned))).toBe(true);
    const after = await snapshot(s.auth);
    const { ticket: _a, ...rowsAfter } = after;
    const { ticket: _b, ...rowsBefore } = before;
    expect(rowsAfter).toEqual(rowsBefore);
    expect(after.ticket(assigned.id)?.assigneeId).toBe(
      s.world.agents.admin.user.id,
    );
    expect(s.keys()).toEqual(keys);
    expect(s.log.filter((entry) => entry.startsWith("storage."))).toEqual([]);
  });

  it("organizationCleanup: false skips row cleanup but still removes the org's blobs", async () => {
    const s = await setup({ organizationCleanup: false });
    const orgId = s.world.customerOrg.id;
    const leaver = s.world.agents.member;
    await seedTicket(s, { organizationId: orgId });
    await seedTicket(s, { organizationId: orgId });
    const orgless = await seedTicket(s);
    const assigned = await insertTicket(s.auth, { assigneeId: leaver.user.id });

    await s.auth.api.deleteOrganization({
      body: { organizationId: orgId },
      headers: s.world.customer.headers,
    });
    await s.auth.api.leaveOrganization({
      body: { organizationId: STAFF_ORG_ID },
      headers: leaver.headers,
    });

    const after = await snapshot(s.auth);
    // memory adapter: no cascade, so the history stays
    expect(
      after.tickets.filter((t) => t.organizationId === orgId),
    ).toHaveLength(2);
    expect(after.attachments).toHaveLength(3);
    expect(after.ticket(assigned.id)?.assigneeId).toBe(leaver.user.id);
    // blobs are unreachable after a SQL cascade, so they always go
    expect(s.keys()).toEqual([orgless.storageKey]);
    expect(s.log).toContain(`storage.deletePrefix support/${orgId}/`);
  });
});

describe("deleteSupportTickets", () => {
  it("deletes the tickets with every child row and blob, in order, and nulls mergedIntoId pointing at them", async () => {
    const s = await setup();
    const one = await seedTicket(s, { organizationId: s.world.customerOrg.id });
    const two = await seedTicket(s);
    const kept = await seedTicket(s);
    const merged = await insertTicket(s.auth, { mergedIntoId: one.ticket.id });
    s.log.length = 0;

    const result = await s.auth.api.deleteSupportTickets({
      body: { ids: [one.ticket.id, two.ticket.id, "no-such-ticket"] },
      headers: s.world.agents.admin.headers,
    });

    expect(result).toEqual({ deleted: 2 });
    const after = await snapshot(s.auth);
    expect(after.tickets.map((t) => t.id).sort()).toEqual(
      [kept.ticket.id, merged.id].sort(),
    );
    expect(after.ticket(merged.id)?.mergedIntoId ?? null).toBeNull();
    expect(after.orphans).toEqual([]);
    expect(after.messages).toHaveLength(1);
    expect(after.tags).toHaveLength(1);
    expect(after.deliveries).toHaveLength(1);
    expect(after.attachments).toHaveLength(1);
    expect(s.keys()).toEqual([kept.storageKey]);
    // the PRD order: deliveries, blobs, attachments, messages, tags, tickets
    const blobs = new Set(
      [one.storageKey, two.storageKey].map((key) => `storage.delete ${key}`),
    );
    expect(s.log.map((entry) => (blobs.has(entry) ? "blob" : entry))).toEqual([
      "deleteMany supportDelivery",
      "blob",
      "blob",
      "deleteMany supportAttachment",
      "deleteMany supportMessage",
      "deleteMany supportTicketTag",
      "deleteMany supportTicket",
      "updateMany supportTicket",
    ]);
  });

  it("deletes 100 tickets in chunks and refuses 0 or 101 ids", async () => {
    const s = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 100; i++) {
      const ticket = await insertTicket(s.auth);
      await insertTag(s.auth, { ticketId: ticket.id, tag: "bulk" });
      ids.push(ticket.id);
    }
    const headers = s.world.agents.admin.headers;

    await expect(
      s.auth.api.deleteSupportTickets({ body: { ids: [] }, headers }),
    ).rejects.toEqual(invalidInput);
    await expect(
      s.auth.api.deleteSupportTickets({
        body: { ids: [...ids, "one-too-many"] },
        headers,
      }),
    ).rejects.toEqual(invalidInput);

    expect(
      await s.auth.api.deleteSupportTickets({ body: { ids }, headers }),
    ).toEqual({ deleted: 100 });
    const after = await snapshot(s.auth);
    expect(after.tickets).toEqual([]);
    expect(after.tags).toEqual([]);
  });

  it("needs support:delete", async () => {
    const s = await setup();
    const ticket = await insertTicket(s.auth);
    const notAllowed = failsWith("FORBIDDEN", SUPPORT_ERROR_CODES.NOT_ALLOWED);

    for (const who of [s.world.agents.lacksDelete, s.world.customer]) {
      await expect(
        s.auth.api.deleteSupportTickets({
          body: { ids: [ticket.id] },
          headers: who.headers,
        }),
      ).rejects.toEqual(notAllowed);
    }
    await expect(
      s.auth.api.deleteSupportTickets({
        body: { ids: [ticket.id] },
        headers: new Headers(),
      }),
    ).rejects.toEqual(failsWith("UNAUTHORIZED"));

    expect((await snapshot(s.auth)).ticket(ticket.id)).toBeDefined();
  });
});

describe("deleteSupportRequesterData", () => {
  it("deletes an account-less person's tickets and anonymizes their messages elsewhere", async () => {
    const s = await setup();
    const first = await seedTicket(s, {
      channel: "email",
      requesterEmail: PAT,
      requesterName: "Pat",
    });
    await seedTicket(s, { channel: "email", requesterEmail: PAT });
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

    expect(
      await deleteSupportRequesterData(s.auth, {
        email: "  PAT@Example.test ",
      }),
    ).toEqual({ tickets: 2, messages: 1 });

    const after = await snapshot(s.auth);
    expect(after.tickets.map((t) => t.id).sort()).toEqual(
      [merged.id, other.ticket.id].sort(),
    );
    expect(after.ticket(merged.id)?.mergedIntoId ?? null).toBeNull();
    expect(after.orphans).toEqual([]);
    expect(after.messages.find((m) => m.id === cc.id)).toMatchObject({
      authorEmail: null,
      authorName: null,
      body: "Hello",
    });
    expect(JSON.stringify(after)).not.toContain(PAT);
    expect(s.keys()).toEqual([other.storageKey]);
  });
});

describe("cleanup inside a better-auth transaction", () => {
  it("deleteOrganizationData uses the transaction adapter: invisible outside until commit, gone on rollback", async () => {
    const s = await setup();
    const orgId = s.world.customerOrg.id;
    await seedTicket(s, { organizationId: orgId });
    await seedTicket(s, { organizationId: orgId });
    const { adapter } = await getContext(s.auth);
    const orgTickets = () =>
      adapter.count({
        model: "supportTicket",
        where: [{ field: "organizationId", value: orgId }],
      });

    await expect(
      runWithTransaction(adapter, async () => {
        expect(await deleteOrganizationData(s.auth, orgId)).toEqual({
          tickets: 2,
        });
        // the live database doesn't see the transaction's deletes yet
        expect(await orgTickets()).toBe(2);
        throw new Error("caller failed");
      }),
    ).rejects.toThrow("caller failed");
    expect(await orgTickets()).toBe(2);
    expect((await snapshot(s.auth)).messages).toHaveLength(2);

    await runWithTransaction(adapter, () =>
      deleteOrganizationData(s.auth, orgId),
    );
    expect(await orgTickets()).toBe(0);
    expect((await snapshot(s.auth)).orphans).toEqual([]);
  });

  it("deleteMemberData and deleteSupportRequesterData roll back with the caller", async () => {
    const s = await setup();
    const agent = s.world.agents.member;
    const assigned = await insertTicket(s.auth, { assigneeId: agent.user.id });
    const emailed = await insertTicket(s.auth, { requesterEmail: PAT });
    const { adapter } = await getContext(s.auth);

    await expect(
      runWithTransaction(adapter, async () => {
        expect(
          await deleteMemberData(s.auth, {
            userId: agent.user.id,
            organizationId: STAFF_ORG_ID,
          }),
        ).toEqual({ unassigned: 1 });
        expect(
          await deleteSupportRequesterData(s.auth, { email: PAT }),
        ).toEqual({ tickets: 1, messages: 0 });
        throw new Error("caller failed");
      }),
    ).rejects.toThrow("caller failed");

    const after = await snapshot(s.auth);
    expect(after.ticket(assigned.id)?.assigneeId).toBe(agent.user.id);
    expect(after.ticket(emailed.id)).toBeDefined();
  });

  it("deleteMemberData changes nothing outside the staff organization", async () => {
    const s = await setup();
    const ticket = await insertTicket(s.auth, {
      assigneeId: s.world.teammate.user.id,
    });

    expect(
      await deleteMemberData(s.auth, {
        userId: s.world.teammate.user.id,
        organizationId: s.world.customerOrg.id,
      }),
    ).toEqual({ unassigned: 0 });
    expect((await snapshot(s.auth)).ticket(ticket.id)?.assigneeId).toBe(
      s.world.teammate.user.id,
    );
  });
});

describe("@byo-oss/core fan-out", () => {
  it("reaches support's sweep, deleteOrganizationData and deleteMemberData hooks", async () => {
    const s = await setup();
    const orgId = s.world.customerOrg.id;
    const agent = s.world.agents.member;
    await seedTicket(s, { organizationId: orgId });
    const assigned = await insertTicket(s.auth, { assigneeId: agent.user.id });

    const swept = await sweepAll(s.auth);
    expect(swept.results).toEqual([
      expect.objectContaining({
        pluginId: "support",
        runs: 1,
        last: expect.objectContaining({ hasMore: false, sent: 0 }),
      }),
    ]);

    await coreDeleteMemberData(s.auth, {
      userId: agent.user.id,
      organizationId: STAFF_ORG_ID,
    });
    await coreDeleteOrganizationData(s.auth, orgId);

    const after = await snapshot(s.auth);
    expect(after.ticket(assigned.id)?.assigneeId ?? null).toBeNull();
    expect(after.tickets.filter((t) => t.organizationId === orgId)).toEqual([]);
    expect(after.orphans).toEqual([]);
    expect(s.keys()).toEqual([]);
  });
});
