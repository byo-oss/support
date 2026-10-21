// PRD acceptance #17: `@byo-oss/core`'s `sweepAll`, `deleteOrganizationData`
// and `deleteMemberData` reach support through its `byo` hooks, on a real
// better-auth with the organization plugin.
import {
  deleteMemberData,
  deleteOrganizationData,
  listByoPlugins,
  sweepAll,
} from "@byo-oss/core";
import { type MemoryMailer, memoryMailer } from "@byo-oss/mailer";
import { describe, expect, it } from "vitest";
import type { SupportOptions } from "./options";
import type { SupportTicketRow } from "./schema";
import {
  createTestAuth,
  getContext,
  STAFF_ORG_ID,
  seedSupportWorld,
  type TestAuth,
} from "./test-utils";

const EMAIL = {
  from: "Support <support@vendor.test>",
  replyDomain: "reply.vendor.test",
  appUrl: "https://app.vendor.test",
  replyDelay: 0,
};

/** The clock must move between the customer's ticket and the agent's reply. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

async function setup(opts: SupportOptions = {}) {
  const mailer = memoryMailer();
  const auth = createTestAuth({
    staffOrganizationId: STAFF_ORG_ID,
    mailer,
    email: EMAIL,
    ...opts,
  });
  const world = await seedSupportWorld(auth);
  return { auth, world, mailer };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function newTicket(
  s: Setup,
  input: { organizationId?: string; subject?: string } = {},
) {
  const { ticket } = await s.auth.api.createSupportTicket({
    body: {
      subject: input.subject ?? "Printer on fire",
      body: "Please help",
      ...(input.organizationId ? { organizationId: input.organizationId } : {}),
    },
    headers: s.world.customer.headers,
  });
  return ticket;
}

async function storedTickets(auth: TestAuth) {
  const { adapter } = await getContext(auth);
  return adapter.findMany<SupportTicketRow>({
    model: "supportTicket",
    limit: 1000,
  });
}

describe("@byo-oss/core finds support", () => {
  it("lists support with its three hooks", async () => {
    const { auth } = await setup();
    expect(listByoPlugins(auth)).toEqual([
      {
        id: "support",
        hooks: ["sweep", "deleteOrganizationData", "deleteMemberData"],
      },
    ]);
  });
});

describe("sweepAll", () => {
  it("reaches support's byo.sweep: a due delivery is sent through the mailer", async () => {
    const s = await setup();
    const ticket = await newTicket(s);
    await tick();
    await s.auth.api.replyAsSupportAgent({
      body: { ticketId: ticket.id, body: "On it" },
      headers: s.world.agents.member.headers,
    });
    // replyDelay 0 and no background handler: the row waits for the sweep
    expect((s.mailer as MemoryMailer).sent).toHaveLength(0);

    const swept = await sweepAll(s.auth);

    expect(swept.hasMore).toBe(false);
    expect(swept.timedOut).toBe(false);
    expect(swept.results).toEqual([
      expect.objectContaining({
        pluginId: "support",
        runs: 1,
        last: expect.objectContaining({ sent: 1, failed: 0, hasMore: false }),
      }),
    ]);
    expect(swept.results[0]?.error).toBeUndefined();

    const sent = (s.mailer as MemoryMailer).sent;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: s.world.customer.user.email,
      subject: `[#${ticket.number}] ${ticket.subject}`,
    });
    expect(sent[0]?.text).toContain("On it");

    // a second sweep has nothing left
    const again = await sweepAll(s.auth);
    expect(again.results[0]?.last).toMatchObject({ sent: 0, hasMore: false });
    expect((s.mailer as MemoryMailer).sent).toHaveLength(1);
  });

  it("sweeps without a mailer too (auto-close and pruning only)", async () => {
    const auth = createTestAuth({ staffOrganizationId: STAFF_ORG_ID });
    await seedSupportWorld(auth);
    const swept = await sweepAll(auth);
    expect(swept.results).toEqual([
      expect.objectContaining({
        pluginId: "support",
        last: expect.objectContaining({ sent: 0, hasMore: false }),
      }),
    ]);
  });
});

describe("deleteOrganizationData", () => {
  it("removes the organization's tickets and leaves everyone else's", async () => {
    const s = await setup();
    const orgId = s.world.customerOrg.id;
    const inOrg = await newTicket(s, { organizationId: orgId });
    const otherInOrg = await newTicket(s, {
      organizationId: orgId,
      subject: "Second",
    });
    const personal = await newTicket(s, { subject: "Mine" });
    expect((await storedTickets(s.auth)).map((t) => t.id).sort()).toEqual(
      [inOrg.id, otherInOrg.id, personal.id].sort(),
    );

    await deleteOrganizationData(s.auth, orgId);

    const left = await storedTickets(s.auth);
    expect(left.map((t) => t.id)).toEqual([personal.id]);

    // its messages went with it
    const { adapter } = await getContext(s.auth);
    const messages = await adapter.findMany<{ ticketId: string }>({
      model: "supportMessage",
      limit: 1000,
    });
    expect(new Set(messages.map((m) => m.ticketId))).toEqual(
      new Set([personal.id]),
    );
  });
});

describe("deleteMemberData", () => {
  it("unassigns a staff member who left the staff organization", async () => {
    const s = await setup();
    const leaver = s.world.agents.member;
    const stays = s.world.agents.admin;
    const mine = await newTicket(s, { subject: "Mine" });
    const theirs = await newTicket(s, { subject: "Theirs" });
    const unassigned = await newTicket(s, { subject: "Nobody's" });
    for (const [ticket, agent] of [
      [mine, leaver],
      [theirs, stays],
    ] as const) {
      await s.auth.api.updateSupportTickets({
        body: { ids: [ticket.id], assigneeId: agent.user.id },
        headers: s.world.agents.owner.headers,
      });
    }

    await deleteMemberData(s.auth, {
      userId: leaver.user.id,
      organizationId: STAFF_ORG_ID,
    });

    const byId = new Map((await storedTickets(s.auth)).map((t) => [t.id, t]));
    expect(byId.get(mine.id)?.assigneeId ?? null).toBeNull();
    expect(byId.get(theirs.id)?.assigneeId).toBe(stays.user.id);
    expect(byId.get(unassigned.id)?.assigneeId ?? null).toBeNull();
    // unassigning keeps the ticket itself
    expect(byId.size).toBe(3);
  });

  it("leaves assignments alone when the member left a customer organization", async () => {
    const s = await setup();
    const agent = s.world.agents.member;
    const ticket = await newTicket(s);
    await s.auth.api.updateSupportTickets({
      body: { ids: [ticket.id], assigneeId: agent.user.id },
      headers: s.world.agents.owner.headers,
    });

    await deleteMemberData(s.auth, {
      userId: agent.user.id,
      organizationId: s.world.customerOrg.id,
    });

    const [row] = await storedTickets(s.auth);
    expect(row?.assigneeId).toBe(agent.user.id);
  });
});
