// PRD acceptance #14 (merge half) and the merge case of #11, through
// `auth.api.*` with the real `resolveMergedTicket`.
import { generateKeyPairSync } from "node:crypto";
import type { ByoEvent } from "@byo-oss/core";
import { memoryMailer } from "@byo-oss/mailer";
import { dkimSign } from "mailauth";
import { beforeAll, describe, expect, it } from "vitest";
import { authRuntime, type SupportRuntime } from "./adapter";
import { SUPPORT_ERROR_CODES } from "./error-codes";
import { receiveEmail } from "./inbound/receive";
import type { DkimResolver } from "./inbound/verify";
import { resolveMergedTicket } from "./merge";
import { SUPPORT_LIMITS, type SupportOptions } from "./options";
import type {
  SupportAttachmentRow,
  SupportDeliveryRow,
  SupportMessageRow,
  SupportTicketRow,
  SupportTicketTagRow,
  TicketVisibility,
} from "./schema";
import {
  type AdapterCall,
  createOrganization,
  createTestAuth,
  getContext,
  insertTag,
  insertTicket,
  STAFF_ORG_ID,
  seedSupportWorld,
  signUpUser,
  type TestRole,
  type TestUser,
} from "./test-utils";
import { memoryStorage } from "./testing/storage";
import { createTicket } from "./tickets";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const REPLY_DOMAIN = "help.test";
const EMAIL = "pat@example.test";

const emailOptions = {
  from: "Acme Support <support@help.test>",
  replyDomain: REPLY_DOMAIN,
  appUrl: "https://app.test",
};

async function setup(opts: SupportOptions = {}) {
  const events: ByoEvent[] = [];
  const calls: AdapterCall[] = [];
  const auth = createTestAuth(
    {
      staffOrganizationId: STAFF_ORG_ID,
      onEvent: (event) => void events.push(event),
      ...opts,
    },
    { adapter: { before: (call) => void calls.push(call) } },
  );
  const world = await seedSupportWorld(auth);
  const rt = await authRuntime(auth, "merge.test");
  events.length = 0;
  return { auth, world, rt, events, calls };
}

type Setup = Awaited<ReturnType<typeof setup>>;

const failsWith = (status: string, code: { code: string }) =>
  expect.objectContaining({
    status,
    body: expect.objectContaining({ code: code.code }),
  });

const mergeNotAllowed = failsWith(
  "BAD_REQUEST",
  SUPPORT_ERROR_CODES.MERGE_NOT_ALLOWED,
);
const notAllowed = failsWith("FORBIDDEN", SUPPORT_ERROR_CODES.NOT_ALLOWED);
const notFound = failsWith("NOT_FOUND", SUPPORT_ERROR_CODES.TICKET_NOT_FOUND);

/** A web ticket, through `createTicket` (first message included). */
async function webTicket(
  s: Setup,
  input: {
    owner?: TestUser;
    subject?: string;
    organizationId?: string | null;
    visibility?: TicketVisibility;
  } = {},
): Promise<SupportTicketRow> {
  const owner = input.owner ?? s.world.customer;
  const { ticket } = await createTicket(s.rt, {
    subject: input.subject ?? "Help",
    body: "It broke",
    channel: "web",
    userId: owner.user.id,
    organizationId:
      input.organizationId === undefined
        ? s.world.customerOrg.id
        : input.organizationId,
    visibility: input.visibility,
    verified: true,
    actorId: owner.user.id,
  });
  return ticket;
}

/** An account-less, org-less email ticket. */
async function emailTicket(
  s: Setup,
  input: { email?: string; verified?: boolean; subject?: string } = {},
): Promise<SupportTicketRow> {
  const { ticket } = await createTicket(s.rt, {
    subject: input.subject ?? "Mail",
    body: "Sent by mail",
    channel: "email",
    requesterEmail: input.email ?? EMAIL,
    requesterName: "Pat",
    verified: input.verified ?? true,
    actorId: null,
  });
  return ticket;
}

function merge(
  s: Setup,
  sourceId: string,
  targetId: string,
  agent: TestUser = s.world.agents.member,
) {
  return s.auth.api.mergeSupportTickets({
    body: { sourceId, targetId },
    headers: agent.headers,
  });
}

async function row(rt: SupportRuntime, id: string): Promise<SupportTicketRow> {
  const found = await rt.adapter.findOne<SupportTicketRow>({
    model: "supportTicket",
    where: [{ field: "id", value: id }],
  });
  if (!found) throw new Error("ticket vanished");
  return found;
}

async function messagesOf(
  rt: SupportRuntime,
  ticketId: string,
): Promise<SupportMessageRow[]> {
  return rt.adapter.findMany<SupportMessageRow>({
    model: "supportMessage",
    where: [{ field: "ticketId", value: ticketId }],
    limit: 1000,
    sortBy: { field: "createdAt", direction: "asc" },
  });
}

async function tagRows(
  rt: SupportRuntime,
  ticketId: string,
): Promise<string[]> {
  const rows = await rt.adapter.findMany<SupportTicketTagRow>({
    model: "supportTicketTag",
    where: [{ field: "ticketId", value: ticketId }],
    limit: 1000,
  });
  return rows.map((r) => r.tag).sort();
}

const eventData = (messages: SupportMessageRow[]) =>
  messages.filter((m) => m.kind === "event").map((m) => m.data);

// ---------------------------------------------------------------------------
// The merge endpoint
// ---------------------------------------------------------------------------

describe("mergeSupportTickets", () => {
  it("merges two tickets of the same requester in the same org", async () => {
    const s = await setup();
    const source = await webTicket(s, { subject: "Source" });
    const target = await webTicket(s, { subject: "Target" });
    const agent = s.world.agents.member;

    const res = await merge(s, source.id, target.id);
    expect(res.ticket).toMatchObject({
      id: target.id,
      subject: "Target",
      status: "open",
    });
    expect(res.ticket).not.toHaveProperty("replyToken");

    // the source is closed and points at the target
    expect(await row(s.rt, source.id)).toMatchObject({
      status: "closed",
      mergedIntoId: target.id,
    });
    expect((await row(s.rt, target.id)).mergedIntoId ?? null).toBeNull();

    // both first messages are on the target now, plus its merged event
    const onTarget = await messagesOf(s.rt, target.id);
    expect(onTarget.filter((m) => m.kind === "reply")).toHaveLength(2);
    expect(eventData(onTarget)).toEqual([{ type: "merged", from: source.id }]);
    const mergedRow = onTarget.find((m) => m.kind === "event");
    expect(mergedRow).toMatchObject({
      authorType: "agent",
      userId: agent.user.id,
    });

    // the source keeps only its own closing and merged event rows
    const onSource = await messagesOf(s.rt, source.id);
    expect(onSource.every((m) => m.kind === "event")).toBe(true);
    expect(eventData(onSource)).toEqual(
      expect.arrayContaining([
        { type: "status", from: "open", to: "closed" },
        { type: "merged", to: target.id },
      ]),
    );
    expect(onSource).toHaveLength(2);
  });

  it("emits support.ticket.merged about the target", async () => {
    const s = await setup();
    const source = await webTicket(s);
    const target = await webTicket(s);
    s.events.length = 0;
    await merge(s, source.id, target.id);
    const merged = s.events.filter((e) => e.type === "support.ticket.merged");
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      type: "support.ticket.merged",
      actorId: s.world.agents.member.user.id,
      userId: s.world.customer.user.id,
      organizationId: s.world.customerOrg.id,
      subject: { type: "supportTicket", id: target.id },
      data: {
        ticketId: target.id,
        sourceId: source.id,
        targetId: target.id,
        visibility: "private",
      },
    });
    // the source's close goes through applyStatus like any status change
    expect(
      s.events.filter((e) => e.type === "support.ticket.status_changed"),
    ).toEqual([
      expect.objectContaining({
        subject: { type: "supportTicket", id: source.id },
        data: {
          ticketId: source.id,
          from: "open",
          to: "closed",
          visibility: "private",
        },
      }),
    ]);
  });

  it("allows account-less tickets with the same requesterEmail", async () => {
    const s = await setup();
    const source = await emailTicket(s, { email: "Pat@Example.TEST" });
    const target = await emailTicket(s, { email: EMAIL });
    const res = await merge(s, source.id, target.id);
    expect(res.ticket.id).toBe(target.id);
    expect(res.ticket.requester).toMatchObject({ id: null, email: EMAIL });
    expect(await row(s.rt, source.id)).toMatchObject({
      status: "closed",
      mergedIntoId: target.id,
    });
  });

  it("refuses tickets in different organizations", async () => {
    const s = await setup();
    const second = await createOrganization(s.auth, s.world.customer, {
      name: "Second",
      slug: "second",
    });
    const inOrg = await webTicket(s);
    const inSecond = await webTicket(s, { organizationId: second.id });
    const orgLess = await webTicket(s, { organizationId: null });

    await expect(merge(s, inOrg.id, inSecond.id)).rejects.toEqual(
      mergeNotAllowed,
    );
    await expect(merge(s, orgLess.id, inOrg.id)).rejects.toEqual(
      mergeNotAllowed,
    );
    await expect(merge(s, inOrg.id, orgLess.id)).rejects.toEqual(
      mergeNotAllowed,
    );
    for (const ticket of [inOrg, inSecond, orgLess]) {
      expect(await row(s.rt, ticket.id)).toMatchObject({ status: "open" });
      expect((await row(s.rt, ticket.id)).mergedIntoId ?? null).toBeNull();
    }
  });

  it("refuses tickets of different requesters", async () => {
    const s = await setup();
    const mine = await webTicket(s);
    const teammates = await webTicket(s, { owner: s.world.teammate });
    await expect(merge(s, mine.id, teammates.id)).rejects.toEqual(
      mergeNotAllowed,
    );

    // two account-less senders
    const pat = await emailTicket(s);
    const sam = await emailTicket(s, { email: "sam@example.test" });
    await expect(merge(s, pat.id, sam.id)).rejects.toEqual(mergeNotAllowed);

    // an account and an account-less sender with the account's address
    const ownOrgLess = await webTicket(s, { organizationId: null });
    const byAddress = await emailTicket(s, {
      email: s.world.customer.user.email,
    });
    await expect(merge(s, byAddress.id, ownOrgLess.id)).rejects.toEqual(
      mergeNotAllowed,
    );
    await expect(merge(s, ownOrgLess.id, byAddress.id)).rejects.toEqual(
      mergeNotAllowed,
    );
    expect(await messagesOf(s.rt, byAddress.id)).toHaveLength(1);
  });

  it("refuses the same id and an already merged source or target; 404 for unknown ids", async () => {
    const s = await setup();
    const a = await webTicket(s);
    const b = await webTicket(s);
    const c = await webTicket(s);

    await expect(merge(s, a.id, a.id)).rejects.toEqual(mergeNotAllowed);
    await merge(s, a.id, b.id);
    // a merged source can't be merged again, nor take merges itself
    await expect(merge(s, a.id, c.id)).rejects.toEqual(mergeNotAllowed);
    await expect(merge(s, c.id, a.id)).rejects.toEqual(mergeNotAllowed);
    expect((await row(s.rt, a.id)).mergedIntoId).toBe(b.id);
    expect(await messagesOf(s.rt, c.id)).toHaveLength(1);

    await expect(merge(s, "missing", b.id)).rejects.toEqual(notFound);
    await expect(merge(s, c.id, "missing")).rejects.toEqual(notFound);
  });

  it("needs support:update", async () => {
    const s = await setup();
    const source = await webTicket(s);
    const target = await webTicket(s);
    const denied: TestRole[] = ["lacksUpdate", "readOnly", "billing"];
    for (const role of denied) {
      await expect(
        merge(s, source.id, target.id, s.world.agents[role]),
      ).rejects.toEqual(notAllowed);
    }
    // a customer-org owner is no agent, even on their own org's tickets
    await expect(
      merge(s, source.id, target.id, s.world.customer),
    ).rejects.toEqual(notAllowed);
    expect((await row(s.rt, source.id)).mergedIntoId ?? null).toBeNull();

    const res = await merge(s, source.id, target.id, s.world.agents.admin);
    expect(res.ticket.id).toBe(target.id);
  });

  it("gives the target the stricter visibility (private wins)", async () => {
    const s = await setup();
    const cases: [TicketVisibility, TicketVisibility, TicketVisibility][] = [
      ["organization", "private", "private"],
      ["private", "organization", "private"],
      ["organization", "organization", "organization"],
    ];
    for (const [from, into, expected] of cases) {
      const source = await webTicket(s, { visibility: from });
      const target = await webTicket(s, { visibility: into });
      const res = await merge(s, source.id, target.id);
      expect(res.ticket.visibility).toBe(expected);
      expect((await row(s.rt, target.id)).visibility).toBe(expected);
    }
  });

  it("gives the target the later lastMessageAt of the two", async () => {
    const s = await setup();
    const earlier = new Date("2026-01-01T00:00:00.000Z");
    const later = new Date("2026-02-01T00:00:00.000Z");
    const setLast = (id: string, lastMessageAt: Date) =>
      s.rt.adapter.update({
        model: "supportTicket",
        where: [{ field: "id", value: id }],
        update: { lastMessageAt },
      });

    // the source is newer: the target moves up to it
    const newer = await webTicket(s);
    const older = await webTicket(s);
    await setLast(newer.id, later);
    await setLast(older.id, earlier);
    const res = await merge(s, newer.id, older.id);
    expect(new Date(res.ticket.lastMessageAt).getTime()).toBe(later.getTime());
    expect(new Date((await row(s.rt, older.id)).lastMessageAt).getTime()).toBe(
      later.getTime(),
    );

    // the source is older: the target keeps its own
    const stale = await webTicket(s);
    const fresh = await webTicket(s);
    await setLast(stale.id, earlier);
    await setLast(fresh.id, later);
    await merge(s, stale.id, fresh.id);
    expect(new Date((await row(s.rt, fresh.id)).lastMessageAt).getTime()).toBe(
      later.getTime(),
    );
  });

  it("gives the target the stricter verified (false wins)", async () => {
    const s = await setup();
    const forged = await emailTicket(s, { verified: false });
    const real = await emailTicket(s, { verified: true });
    const res = await merge(s, forged.id, real.id);
    expect(res.ticket.verified).toBe(false);
    expect((await row(s.rt, real.id)).verified).toBe(false);

    // a verified source can't make an unverified target verified
    const again = await emailTicket(s, { verified: true });
    await merge(s, again.id, real.id);
    expect((await row(s.rt, real.id)).verified).toBe(false);
  });

  it("a forged ticket merged into a real one is never linked by a later verified sign-up (PRD #11)", async () => {
    const s = await setup();
    const forged = await emailTicket(s, { verified: false });
    const real = await emailTicket(s, { verified: true });
    // a control: a verified ticket left alone links as usual
    const control = await emailTicket(s, { verified: true });
    await merge(s, forged.id, real.id);

    const pat = await signUpUser(s.auth, "Pat@Example.test", {
      verified: true,
    });
    expect(await row(s.rt, control.id)).toMatchObject({ userId: pat.user.id });
    const target = await row(s.rt, real.id);
    expect(target.verified).toBe(false);
    expect(target.userId ?? null).toBeNull();
    expect(target.requesterEmail).toBe(EMAIL);
  });

  it("moves tags, deduped against the target's", async () => {
    const s = await setup();
    const source = await webTicket(s);
    const target = await webTicket(s);
    for (const tag of ["billing", "urgent"]) {
      await insertTag(s.auth, { ticketId: source.id, tag });
    }
    for (const tag of ["billing", "vip"]) {
      await insertTag(s.auth, { ticketId: target.id, tag });
    }
    const res = await merge(s, source.id, target.id);
    expect(res.ticket.tags).toEqual(["billing", "urgent", "vip"]);
    expect(await tagRows(s.rt, target.id)).toEqual([
      "billing",
      "urgent",
      "vip",
    ]);
    expect(await tagRows(s.rt, source.id)).toEqual([]);
  });

  it("moves attachments when attachments are configured", async () => {
    const s = await setup({ attachments: { storage: memoryStorage() } });
    const source = await webTicket(s);
    const target = await webTicket(s);
    const [first] = await messagesOf(s.rt, source.id);
    const { adapter } = await getContext(s.auth);
    const attachment = await adapter.create<
      Omit<SupportAttachmentRow, "id">,
      SupportAttachmentRow
    >({
      model: "supportAttachment",
      data: {
        ticketId: source.id,
        messageId: first?.id ?? null,
        userId: s.world.customer.user.id,
        internal: false,
        filename: "invoice.pdf",
        contentType: "application/pdf",
        size: 3,
        storageKey: `support/${s.world.customerOrg.id}/blob`,
        createdAt: new Date(),
      },
    });
    await merge(s, source.id, target.id);
    const moved = await adapter.findOne<SupportAttachmentRow>({
      model: "supportAttachment",
      where: [{ field: "id", value: attachment.id }],
    });
    expect(moved).toMatchObject({
      ticketId: target.id,
      messageId: first?.id,
      storageKey: attachment.storageKey,
    });
  });

  it("moves deliveries when a mailer is configured", async () => {
    const s = await setup({ mailer: memoryMailer(), email: emailOptions });
    const source = await webTicket(s);
    const target = await webTicket(s);
    // an agent reply queues a delivery on the source
    await s.auth.api.replyAsSupportAgent({
      body: { ticketId: source.id, body: "We're on it" },
      headers: s.world.agents.member.headers,
    });
    const { adapter } = await getContext(s.auth);
    const before = await adapter.findMany<SupportDeliveryRow>({
      model: "supportDelivery",
      where: [{ field: "ticketId", value: source.id }],
      limit: 10,
    });
    expect(before).toHaveLength(1);

    await merge(s, source.id, target.id);
    const delivery = await adapter.findOne<SupportDeliveryRow>({
      model: "supportDelivery",
      where: [{ field: "id", value: before[0]?.id ?? "" }],
    });
    expect(delivery).toMatchObject({ ticketId: target.id, status: "pending" });
    // its message moved with it
    const message = await adapter.findOne<SupportMessageRow>({
      model: "supportMessage",
      where: [{ field: "id", value: delivery?.messageId ?? "" }],
    });
    expect(message?.ticketId).toBe(target.id);
  });

  it("touches neither optional table when its feature is off", async () => {
    const s = await setup();
    const source = await webTicket(s);
    const target = await webTicket(s);
    s.calls.length = 0;
    const res = await merge(s, source.id, target.id);
    expect(res.ticket.id).toBe(target.id);
    expect(
      s.calls.filter(
        (call) =>
          call.model === "supportAttachment" ||
          call.model === "supportDelivery",
      ),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Merge following (D2) with the real resolver
// ---------------------------------------------------------------------------

describe("merge following", () => {
  it("customer get, reply, update-mine and mark-seen on the source act on the target", async () => {
    const s = await setup();
    const { customer } = s.world;
    const source = await webTicket(s, { subject: "Source" });
    const target = await webTicket(s, { subject: "Target" });
    await merge(s, source.id, target.id);

    const detail = await s.auth.api.getSupportTicket({
      query: { id: source.id },
      headers: customer.headers,
    });
    expect(detail.ticket).toMatchObject({ id: target.id, subject: "Target" });
    expect(detail.messages.every((m) => m.ticketId === target.id)).toBe(true);
    // both first messages, and the merged event customers may see
    expect(detail.messages.filter((m) => m.kind === "reply")).toHaveLength(2);
    expect(detail.messages.map((m) => m.data)).toContainEqual({
      type: "merged",
      from: source.id,
    });

    const { message } = await s.auth.api.replyToSupportTicket({
      body: { ticketId: source.id, body: "Follow-up" },
      headers: customer.headers,
    });
    expect(message.ticketId).toBe(target.id);
    expect(
      (await messagesOf(s.rt, source.id)).filter((m) => m.kind === "reply"),
    ).toEqual([]);

    const updated = await s.auth.api.updateMySupportTicket({
      body: { id: source.id, status: "solved", rating: "good" },
      headers: customer.headers,
    });
    expect(updated.ticket).toMatchObject({
      id: target.id,
      status: "solved",
      rating: "good",
    });
    expect(await row(s.rt, source.id)).toMatchObject({ status: "closed" });

    const { adapter } = await getContext(s.auth);
    const old = new Date("2020-01-01T00:00:00.000Z");
    await adapter.update({
      model: "supportTicket",
      where: [{ field: "id", value: target.id }],
      update: { requesterSeenAt: old },
    });
    const sourceSeen = (await row(s.rt, source.id)).requesterSeenAt;
    await s.auth.api.markSupportTicketSeen({
      body: { id: source.id },
      headers: customer.headers,
    });
    expect(
      (await row(s.rt, target.id)).requesterSeenAt?.getTime(),
    ).toBeGreaterThan(old.getTime());
    expect((await row(s.rt, source.id)).requesterSeenAt).toEqual(sourceSeen);
  });

  it("re-applies the customer read rule to the resolved ticket", async () => {
    const s = await setup();
    const { teammate, outsider } = s.world;
    const source = await webTicket(s, { visibility: "organization" });
    const target = await webTicket(s, { visibility: "private" });
    const get = (who: TestUser) =>
      s.auth.api.getSupportTicket({
        query: { id: source.id },
        headers: who.headers,
      });
    expect((await get(teammate)).ticket.id).toBe(source.id);

    await merge(s, source.id, target.id);
    for (const who of [teammate, outsider]) {
      await expect(get(who)).rejects.toEqual(notFound);
      await expect(
        s.auth.api.replyToSupportTicket({
          body: { ticketId: source.id, body: "Me too" },
          headers: who.headers,
        }),
      ).rejects.toEqual(notFound);
      await expect(
        s.auth.api.updateMySupportTicket({
          body: { id: source.id, rating: "bad" },
          headers: who.headers,
        }),
      ).rejects.toEqual(notFound);
      await expect(
        s.auth.api.markSupportTicketSeen({
          body: { id: source.id },
          headers: who.headers,
        }),
      ).rejects.toEqual(notFound);
    }
    expect(
      (await messagesOf(s.rt, target.id)).filter((m) => m.kind === "reply"),
    ).toHaveLength(2);
  });

  it("agent get, reply and mark-seen on the source act on the target", async () => {
    const s = await setup();
    const agent = s.world.agents.member;
    const source = await webTicket(s, { subject: "Source" });
    const target = await webTicket(s, { subject: "Target" });
    await merge(s, source.id, target.id);

    const detail = await s.auth.api.getSupportTicketAsAgent({
      query: { id: source.id },
      headers: agent.headers,
    });
    expect(detail.ticket).toMatchObject({ id: target.id, subject: "Target" });
    expect(detail.messages.every((m) => m.ticketId === target.id)).toBe(true);

    const { message } = await s.auth.api.replyAsSupportAgent({
      body: { ticketId: source.id, body: "On it" },
      headers: agent.headers,
    });
    expect(message.ticketId).toBe(target.id);
    expect(await row(s.rt, target.id)).toMatchObject({ status: "pending" });
    expect(await row(s.rt, source.id)).toMatchObject({ status: "closed" });

    const { adapter } = await getContext(s.auth);
    await adapter.update({
      model: "supportTicket",
      where: [{ field: "id", value: target.id }],
      update: { agentSeenAt: null },
    });
    const sourceSeen = (await row(s.rt, source.id)).agentSeenAt ?? null;
    await s.auth.api.markSupportTicketSeenAsAgent({
      body: { id: source.id },
      headers: agent.headers,
    });
    expect((await row(s.rt, target.id)).agentSeenAt).toBeInstanceOf(Date);
    expect((await row(s.rt, source.id)).agentSeenAt ?? null).toEqual(
      sourceSeen,
    );
  });

  it("a bulk update naming two sources merged into one target updates it once", async () => {
    const s = await setup();
    const first = await webTicket(s);
    const second = await webTicket(s);
    const target = await webTicket(s);
    await merge(s, first.id, target.id);
    await merge(s, second.id, target.id);

    const res = await s.auth.api.updateSupportTickets({
      body: { ids: [first.id, second.id], priority: "high" },
      headers: s.world.agents.member.headers,
    });
    expect(res).toEqual({ updated: 1 });
    expect((await row(s.rt, target.id)).priority).toBe("high");
    expect((await row(s.rt, first.id)).priority ?? null).toBeNull();
    expect((await row(s.rt, second.id)).priority ?? null).toBeNull();
    const priorityEvents = eventData(await messagesOf(s.rt, target.id)).filter(
      (data) => data?.type === "priority",
    );
    expect(priorityEvents).toHaveLength(1);
  });

  it("a chain A→B→C resolves to C", async () => {
    const s = await setup();
    const a = await webTicket(s, { subject: "A" });
    const b = await webTicket(s, { subject: "B" });
    const c = await webTicket(s, { subject: "C" });
    await merge(s, a.id, b.id);
    // B took a merge but isn't merged itself, so it can still be merged
    await merge(s, b.id, c.id);

    const fresh = await row(s.rt, a.id);
    expect((await resolveMergedTicket(s.rt.adapter, fresh)).id).toBe(c.id);
    const asCustomer = await s.auth.api.getSupportTicket({
      query: { id: a.id },
      headers: s.world.customer.headers,
    });
    expect(asCustomer.ticket).toMatchObject({ id: c.id, subject: "C" });
    const asAgent = await s.auth.api.getSupportTicketAsAgent({
      query: { id: a.id },
      headers: s.world.agents.member.headers,
    });
    expect(asAgent.ticket.id).toBe(c.id);
    // all three first messages ended on C
    expect(
      (await messagesOf(s.rt, c.id)).filter((m) => m.kind === "reply"),
    ).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Inbound mail threaded to a merged ticket
// ---------------------------------------------------------------------------

describe("inbound mail to a merged ticket", () => {
  const SELECTOR = "byo";
  const records = new Map<string, string>();
  const resolver: DkimResolver = async (name, rrtype) => {
    const txt = rrtype === "TXT" ? records.get(name.toLowerCase()) : undefined;
    if (txt) return [[txt]];
    throw Object.assign(new Error(`queryTxt ENOTFOUND ${name}`), {
      code: "ENOTFOUND",
    });
  };
  let privateKey = "";

  beforeAll(() => {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    privateKey = pair.privateKey.export({
      type: "pkcs8",
      format: "pem",
    }) as string;
    const publicKey = pair.publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64");
    records.set(
      `${SELECTOR}._domainkey.acme.test`,
      `v=DKIM1; k=rsa; p=${publicKey}`,
    );
  });

  async function signedMail(input: {
    from: string;
    to: string;
  }): Promise<Uint8Array> {
    const message = [
      `From: Cora Customer <${input.from}>`,
      `To: ${input.to}`,
      "Subject: Re: Help",
      "Message-ID: <merge-follow-1@acme.test>",
      "Date: Tue, 20 Oct 2026 11:15:00 +0000",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Any news?",
      "",
    ].join("\r\n");
    const { signatures, errors } = await dkimSign(message, {
      signatureData: [
        { signingDomain: "acme.test", selector: SELECTOR, privateKey },
      ],
    });
    expect(errors).toEqual([]);
    return new TextEncoder().encode(signatures + message);
  }

  it("lands on the target", async () => {
    const s = await setup({
      mailer: memoryMailer(),
      email: emailOptions,
      inbound: { source: { receive: async () => ({ reject: 401 }) } },
    });
    const source = await webTicket(s, { subject: "Source" });
    const target = await webTicket(s, { subject: "Target" });
    await merge(s, source.id, target.id);

    const { replyToken } = await row(s.rt, source.id);
    const result = await receiveEmail(
      s.rt,
      await signedMail({
        from: s.world.customer.user.email,
        to: `support+${replyToken}@${REPLY_DOMAIN}`,
      }),
      { resolver },
    );
    expect(result).toMatchObject({ status: "appended", ticketId: target.id });
    const onTarget = await messagesOf(s.rt, target.id);
    expect(onTarget.find((m) => m.body.includes("Any news?"))).toMatchObject({
      channel: "email",
      verified: true,
      userId: s.world.customer.user.id,
    });
    expect(
      (await messagesOf(s.rt, source.id)).filter((m) => m.kind === "reply"),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// resolveMergedTicket: hop limit, cycles, dangling ids
// ---------------------------------------------------------------------------

describe("resolveMergedTicket", () => {
  const lookups = (s: Setup) =>
    s.calls.filter(
      (call) => call.method === "findOne" && call.model === "supportTicket",
    ).length;

  async function link(s: Setup, from: string, to: string) {
    const { adapter } = await getContext(s.auth);
    await adapter.update({
      model: "supportTicket",
      where: [{ field: "id", value: from }],
      update: { mergedIntoId: to },
    });
  }

  it("returns an unmerged ticket as is, without a query", async () => {
    const s = await setup();
    const ticket = await insertTicket(s.auth);
    s.calls.length = 0;
    expect(await resolveMergedTicket(s.rt.adapter, ticket)).toBe(ticket);
    expect(lookups(s)).toBe(0);
  });

  it("follows at most mergeHops hops", async () => {
    const s = await setup();
    const chain: SupportTicketRow[] = [];
    for (let i = 0; i < SUPPORT_LIMITS.mergeHops + 2; i++) {
      chain.push(await insertTicket(s.auth, { subject: `T${i}` }));
    }
    for (let i = 0; i + 1 < chain.length; i++) {
      await link(s, chain[i]?.id ?? "", chain[i + 1]?.id ?? "");
    }
    const start = await row(s.rt, chain[0]?.id ?? "");
    s.calls.length = 0;
    const resolved = await resolveMergedTicket(s.rt.adapter, start);
    expect(resolved.id).toBe(chain[SUPPORT_LIMITS.mergeHops]?.id);
    expect(lookups(s)).toBe(SUPPORT_LIMITS.mergeHops);
  });

  it("stops on a cycle", async () => {
    const s = await setup();
    const x = await insertTicket(s.auth, { subject: "X" });
    const y = await insertTicket(s.auth, { subject: "Y" });
    await link(s, x.id, y.id);
    await link(s, y.id, x.id);
    const start = await row(s.rt, x.id);
    s.calls.length = 0;
    const resolved = await resolveMergedTicket(s.rt.adapter, start);
    // X → Y, and Y points back at X, which was already visited
    expect(resolved.id).toBe(y.id);
    expect(lookups(s)).toBe(1);
  });

  it("stops at the last ticket found when mergedIntoId dangles", async () => {
    const s = await setup();
    const a = await insertTicket(s.auth, { subject: "A" });
    const b = await insertTicket(s.auth, {
      subject: "B",
      mergedIntoId: "gone",
    });
    await link(s, a.id, b.id);
    const resolved = await resolveMergedTicket(
      s.rt.adapter,
      await row(s.rt, a.id),
    );
    expect(resolved.id).toBe(b.id);
  });
});
