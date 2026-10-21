// PRD acceptance #26: customer and agent lists on a real SQL database (PGlite
// rejects `IN ()`, which SQLite would accept).
import { afterEach, describe, expect, it } from "vitest";
import { authRuntime, endpointRuntime, type SupportRuntime } from "./adapter";
import { SUPPORT_ERROR_CODES } from "./error-codes";
import type { SupportOptions } from "./options";
import {
  decodeCursor,
  encodeCursor,
  listAgentTickets,
  listCustomerTickets,
  type TicketPage,
} from "./queries";
import type { SupportTicketRow } from "./schema";
import { createSqlTestAuth } from "./test-sql";
import {
  getContext,
  insertTag,
  insertTicket,
  removeMember,
  STAFF_ORG_ID,
  seedSupportWorld,
  signUpUser,
} from "./test-utils";

type Harness = Awaited<ReturnType<typeof createSqlTestAuth>>;
let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

/** A PGlite auth with the world seeded, its runtime, and a findMany counter. */
async function setup(opts: SupportOptions = {}) {
  const calls = { ticketFindMany: 0 };
  harness = await createSqlTestAuth(
    { staffOrganizationId: STAFF_ORG_ID, ...opts },
    {
      adapter: {
        before: ({ method, model }) => {
          if (method === "findMany" && model === "supportTicket") {
            calls.ticketFindMany++;
          }
        },
      },
    },
  );
  const { auth } = harness;
  const world = await seedSupportWorld(auth);
  const context = await getContext(auth);
  const resolved = (await authRuntime(auth, "test")).opts;
  // the runtime an endpoint handler builds (`ctx.context.adapter`)
  const rt: SupportRuntime = endpointRuntime({ context }, resolved);
  return { auth, world, rt, calls, adapter: context.adapter };
}

const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 12, minute, 0, 0));

const ids = (page: TicketPage) => page.tickets.map((t) => t.id);
const sorted = (values: string[]) => [...values].sort();

/** Follows `nextCursor` to the end; returns every row in order. */
async function pageAll(
  fetch: (cursor: string | undefined) => Promise<TicketPage>,
  pageSize: number,
): Promise<SupportTicketRow[]> {
  const rows: SupportTicketRow[] = [];
  let cursor: string | undefined;
  for (let pages = 0; ; pages++) {
    expect(pages).toBeLessThan(200);
    const page = await fetch(cursor);
    expect(page.tickets.length).toBeLessThanOrEqual(pageSize);
    rows.push(...page.tickets);
    if (!page.nextCursor) return rows;
    expect(page.tickets).toHaveLength(pageSize);
    cursor = page.nextCursor;
  }
}

/** Every id exactly once, ordered `(lastMessageAt desc)` across pages. */
function expectEachOnceInOrder(rows: SupportTicketRow[], expected: string[]) {
  const seen = rows.map((r) => r.id);
  expect(new Set(seen).size).toBe(seen.length);
  expect(sorted(seen)).toEqual(sorted(expected));
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1] as SupportTicketRow;
    const row = rows[i] as SupportTicketRow;
    expect(new Date(prev.lastMessageAt).getTime()).toBeGreaterThanOrEqual(
      new Date(row.lastMessageAt).getTime(),
    );
  }
}

const invalidCursor = expect.objectContaining({
  status: "BAD_REQUEST",
  body: expect.objectContaining({
    code: SUPPORT_ERROR_CODES.INVALID_CURSOR.code,
  }),
});

describe("customer list (own + org-shared, merged in code)", () => {
  it("lists a customer with no organization's own tickets, with no shared query", async () => {
    const { auth, world, rt, calls } = await setup();
    const a = await insertTicket(auth, { userId: world.outsider.user.id });
    const b = await insertTicket(auth, { userId: world.outsider.user.id });
    calls.ticketFindMany = 0;
    const page = await listCustomerTickets(rt, {
      userId: world.outsider.user.id,
      filters: {},
    });
    expect(sorted(ids(page))).toEqual(sorted([a.id, b.id]));
    expect(page.nextCursor).toBeNull();
    expect(calls.ticketFindMany).toBe(1);
  });

  it("lists exactly what the read rule allows, once each", async () => {
    const { auth, world, rt } = await setup();
    const { customer, teammate, outsider, customerOrg } = world;
    const { id: otherOrg } = await auth.api.createOrganization({
      body: { name: "Other", slug: "other" },
      headers: outsider.headers,
    });
    const ownNoOrg = await insertTicket(auth, { userId: customer.user.id });
    const ownPrivateInOrg = await insertTicket(auth, {
      userId: customer.user.id,
      organizationId: customerOrg.id,
    });
    // own and shared at once: must appear once
    const ownShared = await insertTicket(auth, {
      userId: customer.user.id,
      organizationId: customerOrg.id,
      visibility: "organization",
    });
    const teammatePrivate = await insertTicket(auth, {
      userId: teammate.user.id,
      organizationId: customerOrg.id,
    });
    const teammateShared = await insertTicket(auth, {
      userId: teammate.user.id,
      organizationId: customerOrg.id,
      visibility: "organization",
    });
    const otherShared = await insertTicket(auth, {
      userId: outsider.user.id,
      organizationId: otherOrg,
      visibility: "organization",
    });
    // an account-less ticket in the org, shared: visible to members
    const emailShared = await insertTicket(auth, {
      channel: "email",
      requesterEmail: "anon@acme.test",
      organizationId: customerOrg.id,
      visibility: "organization",
    });

    const list = async (userId: string) =>
      ids(await listCustomerTickets(rt, { userId, filters: {} }));

    const forCustomer = await list(customer.user.id);
    expect(forCustomer).toHaveLength(new Set(forCustomer).size);
    expect(sorted(forCustomer)).toEqual(
      sorted([
        ownNoOrg.id,
        ownPrivateInOrg.id,
        ownShared.id,
        teammateShared.id,
        emailShared.id,
      ]),
    );
    expect(forCustomer).not.toContain(teammatePrivate.id);
    expect(forCustomer).not.toContain(otherShared.id);

    expect(sorted(await list(teammate.user.id))).toEqual(
      sorted([
        teammatePrivate.id,
        teammateShared.id,
        ownShared.id,
        emailShared.id,
      ]),
    );
    expect(sorted(await list(outsider.user.id))).toEqual([otherShared.id]);
    // staff see nothing here: the customer list is not the queue
    expect(await list(world.agents.owner.user.id)).toEqual([]);
  });

  it("chunks the shared queries at 90 organizations", async () => {
    const { auth, rt, calls, adapter } = await setup();
    const many = await signUpUser(auth, "many@orgs.test", { verified: true });
    const author = await signUpUser(auth, "author@orgs.test");
    const orgIds: string[] = [];
    for (let i = 0; i < 95; i++) {
      const id = `org_many_${String(i).padStart(3, "0")}`;
      await adapter.create({
        model: "organization",
        data: { id, name: `Org ${i}`, slug: id, createdAt: new Date() },
        forceAllowId: true,
      });
      await adapter.create({
        model: "member",
        data: {
          organizationId: id,
          userId: many.user.id,
          role: "member",
          createdAt: new Date(),
        },
      });
      orgIds.push(id);
    }
    const { id: notMine } = await auth.api.createOrganization({
      body: { name: "Not mine", slug: "not-mine" },
      headers: author.headers,
    });
    // shared tickets on both sides of the chunk boundary
    const expected: string[] = [];
    for (const index of [0, 45, 89, 90, 94]) {
      const t = await insertTicket(auth, {
        userId: author.user.id,
        organizationId: orgIds[index],
        visibility: "organization",
      });
      expected.push(t.id);
    }
    const own = await insertTicket(auth, { userId: many.user.id });
    expected.push(own.id);
    // private in one of my orgs, and shared in an org I'm not in: hidden
    await insertTicket(auth, {
      userId: author.user.id,
      organizationId: orgIds[91],
    });
    await insertTicket(auth, {
      userId: author.user.id,
      organizationId: notMine,
      visibility: "organization",
    });

    calls.ticketFindMany = 0;
    const page = await listCustomerTickets(rt, {
      userId: many.user.id,
      filters: {},
    });
    expect(sorted(ids(page))).toEqual(sorted(expected));
    // own + ceil(95 / 90) shared queries
    expect(calls.ticketFindMany).toBe(3);

    // the organizationId filter narrows both queries
    calls.ticketFindMany = 0;
    const narrowed = await listCustomerTickets(rt, {
      userId: many.user.id,
      filters: { organizationId: orgIds[90] },
    });
    expect(ids(narrowed)).toEqual([expected[3]]);
    expect(calls.ticketFindMany).toBe(2);
  });

  it("drops a removed teammate's shared tickets at once; a removed requester keeps their own", async () => {
    const { auth, world, rt } = await setup();
    const { customer, teammate, customerOrg } = world;
    const byCustomer = await insertTicket(auth, {
      userId: customer.user.id,
      organizationId: customerOrg.id,
      visibility: "organization",
    });
    const byTeammate = await insertTicket(auth, {
      userId: teammate.user.id,
      organizationId: customerOrg.id,
      visibility: "organization",
    });
    const teammatePrivate = await insertTicket(auth, {
      userId: teammate.user.id,
      organizationId: customerOrg.id,
    });
    const list = async (userId: string) =>
      sorted(ids(await listCustomerTickets(rt, { userId, filters: {} })));

    expect(await list(teammate.user.id)).toEqual(
      sorted([byCustomer.id, byTeammate.id, teammatePrivate.id]),
    );
    await removeMember(auth, {
      organizationId: customerOrg.id,
      member: teammate,
      by: customer,
    });
    expect(await list(teammate.user.id)).toEqual(
      sorted([byTeammate.id, teammatePrivate.id]),
    );
    expect(await list(customer.user.id)).toEqual(
      sorted([byCustomer.id, byTeammate.id]),
    );
  });

  it("returns every ticket once when a lastMessageAt tie spans page boundaries", async () => {
    const pageSize = 2;
    const { auth, world, rt } = await setup({ pageSize });
    const { customer, teammate, customerOrg } = world;
    const expected: string[] = [];
    const add = async (minute: number, mine: boolean) => {
      const t = await insertTicket(auth, {
        userId: mine ? customer.user.id : teammate.user.id,
        organizationId: customerOrg.id,
        visibility: mine ? "private" : "organization",
        lastMessageAt: at(minute),
      });
      expected.push(t.id);
      return t;
    };
    await add(30, true);
    await add(20, false);
    // seven at one instant, from the own and the shared query alike
    for (let i = 0; i < 7; i++) await add(10, i % 2 === 0);
    await add(5, false);
    await add(1, true);
    // one the customer can't see, inside the tie
    await insertTicket(auth, {
      userId: teammate.user.id,
      organizationId: customerOrg.id,
      lastMessageAt: at(10),
    });

    const rows = await pageAll(
      (cursor) =>
        listCustomerTickets(rt, {
          userId: customer.user.id,
          filters: { cursor },
        }),
      pageSize,
    );
    expectEachOnceInOrder(rows, expected);

    // the first page is ordered (lastMessageAt desc, id desc)
    const first = await listCustomerTickets(rt, {
      userId: customer.user.id,
      filters: {},
    });
    expect(first.tickets.map((t) => new Date(t.lastMessageAt))).toEqual([
      at(30),
      at(20),
    ]);
    const third = await listCustomerTickets(rt, {
      userId: customer.user.id,
      filters: {
        cursor: (
          await listCustomerTickets(rt, {
            userId: customer.user.id,
            filters: { cursor: first.nextCursor ?? undefined },
          })
        ).nextCursor as string,
      },
    });
    const [x, y] = third.tickets;
    expect(x && y && x.id > y.id).toBe(true);
  });

  it("applies status, organizationId and q to both queries", async () => {
    const { auth, world, rt } = await setup();
    const { customer, teammate, customerOrg } = world;
    const ownOpen = await insertTicket(auth, {
      userId: customer.user.id,
      subject: "Invoice is wrong",
    });
    const ownSolved = await insertTicket(auth, {
      userId: customer.user.id,
      organizationId: customerOrg.id,
      status: "solved",
      subject: "Login loop",
    });
    const sharedOpen = await insertTicket(auth, {
      userId: teammate.user.id,
      organizationId: customerOrg.id,
      visibility: "organization",
      subject: "INVOICE missing",
    });
    const list = async (
      filters: Parameters<typeof listCustomerTickets>[1]["filters"],
    ) =>
      sorted(
        ids(
          await listCustomerTickets(rt, { userId: customer.user.id, filters }),
        ),
      );

    expect(await list({ status: "open" })).toEqual(
      sorted([ownOpen.id, sharedOpen.id]),
    );
    expect(await list({ status: "solved" })).toEqual([ownSolved.id]);
    expect(await list({ organizationId: customerOrg.id })).toEqual(
      sorted([ownSolved.id, sharedOpen.id]),
    );
    expect(await list({ organizationId: "org_not_mine" })).toEqual([]);
    // subject contains, case-insensitive
    expect(await list({ q: "invoice" })).toEqual(
      sorted([ownOpen.id, sharedOpen.id]),
    );
    // a number, with or without #, matches exactly
    expect(await list({ q: `#${sharedOpen.number}` })).toEqual([sharedOpen.id]);
    expect(await list({ q: ` ${ownSolved.number} ` })).toEqual([ownSolved.id]);
    expect(await list({ q: "99999" })).toEqual([]);
  });
});

describe("agent list", () => {
  it("returns every ticket once when a lastMessageAt tie spans page boundaries", async () => {
    const pageSize = 2;
    const { auth, world, rt } = await setup({ pageSize });
    const expected: string[] = [];
    for (const minute of [40, 30, 10, 10, 10, 10, 10, 10, 10, 5, 1]) {
      const t = await insertTicket(auth, {
        userId: world.customer.user.id,
        lastMessageAt: at(minute),
      });
      expected.push(t.id);
    }
    const rows = await pageAll(
      (cursor) =>
        listAgentTickets(rt, {
          viewerId: world.agents.member.user.id,
          filters: { cursor },
        }),
      pageSize,
    );
    expectEachOnceInOrder(rows, expected);
  });

  it("filters by status, assignee, organization, q and tag (chunked), with queue-wide counts", async () => {
    const { auth, world, rt, calls } = await setup({ pageSize: 50 });
    const me = world.agents.member.user.id;
    const other = world.agents.admin.user.id;
    const { customer, customerOrg } = world;
    const openMine = await insertTicket(auth, {
      userId: customer.user.id,
      assigneeId: me,
      subject: "Refund please",
    });
    const pendingMine = await insertTicket(auth, {
      userId: customer.user.id,
      status: "pending",
      assigneeId: me,
    });
    const openNone = await insertTicket(auth, {
      userId: customer.user.id,
      organizationId: customerOrg.id,
      subject: "REFUND again",
    });
    const pendingOther = await insertTicket(auth, {
      userId: customer.user.id,
      status: "pending",
      assigneeId: other,
    });
    const solvedMine = await insertTicket(auth, {
      userId: customer.user.id,
      status: "solved",
      assigneeId: me,
    });
    const closedNone = await insertTicket(auth, {
      channel: "email",
      requesterEmail: "anon@acme.test",
      status: "closed",
    });
    await insertTag(auth, { ticketId: openNone.id, tag: "billing" });
    await insertTag(auth, { ticketId: solvedMine.id, tag: "billing" });
    await insertTag(auth, { ticketId: pendingOther.id, tag: "bug" });

    const list = async (
      filters: Parameters<typeof listAgentTickets>[1]["filters"],
      viewerId = me,
    ) => listAgentTickets(rt, { viewerId, filters });
    const listIds = async (
      filters: Parameters<typeof listAgentTickets>[1]["filters"],
    ) => sorted(ids(await list(filters)));

    const all = await list({});
    expect(sorted(ids(all))).toEqual(
      sorted([
        openMine.id,
        pendingMine.id,
        openNone.id,
        pendingOther.id,
        solvedMine.id,
        closedNone.id,
      ]),
    );
    // open: openMine, openNone; pending: pendingMine, pendingOther;
    // unassigned open/pending: openNone; mine open/pending: openMine, pendingMine
    expect(all.counts).toEqual({ open: 2, pending: 2, unassigned: 1, mine: 2 });
    // counts ignore filters, and "mine" follows the viewer
    expect((await list({ status: "closed" })).counts).toEqual(all.counts);
    expect((await list({}, other)).counts).toEqual({
      open: 2,
      pending: 2,
      unassigned: 1,
      mine: 1,
    });

    expect(await listIds({ status: "pending" })).toEqual(
      sorted([pendingMine.id, pendingOther.id]),
    );
    expect(await listIds({ assignee: "me" })).toEqual(
      sorted([openMine.id, pendingMine.id, solvedMine.id]),
    );
    expect(await listIds({ assignee: "none" })).toEqual(
      sorted([openNone.id, closedNone.id]),
    );
    expect(await listIds({ assignee: other })).toEqual([pendingOther.id]);
    expect(await listIds({ assignee: "me", status: "open" })).toEqual([
      openMine.id,
    ]);
    expect(await listIds({ organizationId: customerOrg.id })).toEqual([
      openNone.id,
    ]);
    expect(await listIds({ q: "refund" })).toEqual(
      sorted([openMine.id, openNone.id]),
    );
    expect(await listIds({ q: String(pendingOther.number) })).toEqual([
      pendingOther.id,
    ]);
    expect(await listIds({ tag: "billing" })).toEqual(
      sorted([openNone.id, solvedMine.id]),
    );
    expect(await listIds({ tag: " Billing " })).toEqual(
      sorted([openNone.id, solvedMine.id]),
    );
    expect(await listIds({ tag: "billing", assignee: "me" })).toEqual([
      solvedMine.id,
    ]);
    calls.ticketFindMany = 0;
    const none = await list({ tag: "nothing" });
    expect(ids(none)).toEqual([]);
    expect(none.nextCursor).toBeNull();
    expect(none.counts).toEqual(all.counts);
    expect(calls.ticketFindMany).toBe(0);
  });

  it("pages a tag on more than 90 tickets, 90 ids per query", async () => {
    const pageSize = 25;
    const { auth, world, rt, calls } = await setup({ pageSize });
    const expected: string[] = [];
    for (let i = 0; i < 95; i++) {
      const t = await insertTicket(auth, {
        userId: world.customer.user.id,
        lastMessageAt: at(i % 7),
      });
      await insertTag(auth, { ticketId: t.id, tag: "vip" });
      expected.push(t.id);
    }
    const untagged = await insertTicket(auth, {
      userId: world.customer.user.id,
    });
    calls.ticketFindMany = 0;
    const rows = await pageAll(
      (cursor) =>
        listAgentTickets(rt, {
          viewerId: world.agents.member.user.id,
          filters: { tag: "vip", cursor },
        }),
      pageSize,
    );
    expectEachOnceInOrder(rows, expected);
    expect(rows.map((r) => r.id)).not.toContain(untagged.id);
    // four pages, two chunk queries each
    expect(calls.ticketFindMany).toBe(8);
  });
});

describe("cursor", () => {
  it("round-trips { at, ids } as URL-safe base64", () => {
    const cursor = { at: at(3), ids: ["a", "b+/c", "ü"] };
    const encoded = encodeCursor(cursor);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(encoded)).toEqual(cursor);
  });

  it("refuses a malformed cursor or more than 200 ids with 400 INVALID_CURSOR", async () => {
    const b64 = (value: unknown) => btoa(JSON.stringify(value));
    const bad = [
      "",
      "not base64 !",
      b64("just a string"),
      b64(null),
      b64({ ids: [] }),
      b64({ at: "yesterday", ids: [] }),
      b64({ at: at(1).toISOString() }),
      b64({ at: at(1).toISOString(), ids: [1] }),
      b64({ at: at(1).toISOString(), ids: [""] }),
      b64({
        at: at(1).toISOString(),
        ids: Array.from({ length: 201 }, (_, i) => `t${i}`),
      }),
    ];
    for (const value of bad) {
      expect(() => decodeCursor(value), value).toThrow(
        expect.objectContaining({ status: "BAD_REQUEST" }),
      );
      try {
        decodeCursor(value);
      } catch (error) {
        expect(error).toEqual(invalidCursor);
      }
    }
    const max = Array.from({ length: 200 }, (_, i) => `t${i}`);
    expect(
      decodeCursor(b64({ at: at(1).toISOString(), ids: max })).ids,
    ).toHaveLength(200);

    const { world, rt } = await setup();
    await expect(
      listCustomerTickets(rt, {
        userId: world.customer.user.id,
        filters: { cursor: "%%%" },
      }),
    ).rejects.toEqual(invalidCursor);
    await expect(
      listAgentTickets(rt, {
        viewerId: world.agents.member.user.id,
        filters: { cursor: "%%%" },
      }),
    ).rejects.toEqual(invalidCursor);
  });
});
