// PRD acceptance #27: concurrent numbering on a real SQL database (PGlite).
import { afterEach, describe, expect, it } from "vitest";
import { allocateTicketNumber } from "./counter";
import { createSqlTestAuth } from "./test-sql";
import {
  getContext,
  insertTicket,
  seedSupportWorld,
  staffOrgIdFor,
} from "./test-utils";

type Harness = Awaited<ReturnType<typeof createSqlTestAuth>>;
let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

describe.each([
  { ids: "default ids", generateId: undefined },
  { ids: "uuid ids", generateId: "uuid" as const },
])("allocateTicketNumber on PGlite ($ids)", ({ generateId }) => {
  it("gives N concurrent first tickets on an empty database distinct numbers 1..N", async () => {
    const calls = { incrementOne: 0, create: 0 };
    harness = await createSqlTestAuth(
      {},
      {
        generateId,
        adapter: {
          before: ({ method, model }) => {
            if (model !== "supportCounter") return;
            if (method === "incrementOne") calls.incrementOne++;
            if (method === "create") calls.create++;
          },
        },
      },
    );
    const { auth } = harness;
    const { adapter } = await getContext(auth);
    const n = 12;
    const numbers = await Promise.all(
      range(n).map(() => allocateTicketNumber(adapter)),
    );
    expect([...numbers].sort((a, b) => a - b)).toEqual(range(n));

    // the unique `number` constraint accepts every allocated number once
    await Promise.all(numbers.map((number) => insertTicket(auth, { number })));
    const tickets = await harness.db
      .selectFrom("supportTicket")
      .select("number")
      .execute();
    expect(tickets.map((t) => t.number).sort((a, b) => a - b)).toEqual(
      range(n),
    );

    const counters = await harness.db
      .selectFrom("supportCounter")
      .selectAll()
      .execute();
    expect(counters).toHaveLength(1);
    expect(counters[0]).toMatchObject({ key: "ticket", value: n });
    if (generateId === "uuid") {
      expect(counters[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    }
    // every request found no row, at most one create won, the rest retried
    expect(calls.create).toBeGreaterThanOrEqual(1);
    expect(calls.incrementOne).toBe(n + (calls.create - 1));
  });

  it("retries the increment when its create loses to a concurrent create (forced)", async () => {
    let raced = false;
    let increments = 0;
    harness = await createSqlTestAuth(
      {},
      {
        generateId,
        adapter: {
          before: async ({ method, model }) => {
            if (model !== "supportCounter") return;
            if (method === "incrementOne") increments++;
            if (method === "create" && !raced) {
              // another request inserts the row between our increment and create
              raced = true;
              await harness?.db
                .insertInto("supportCounter")
                .values({ id: crypto.randomUUID(), key: "ticket", value: 1 })
                .execute();
            }
          },
        },
      },
    );
    const { adapter } = await getContext(harness.auth);
    expect(await allocateTicketNumber(adapter)).toBe(2);
    expect(raced).toBe(true);
    expect(increments).toBe(2);
    expect(await allocateTicketNumber(adapter)).toBe(3);
  });

  it("refuses a duplicate ticket number (the backstop for emulated increments)", async () => {
    harness = await createSqlTestAuth({}, { generateId });
    await insertTicket(harness.auth, { number: 1 });
    await expect(insertTicket(harness.auth, { number: 1 })).rejects.toThrow();
  });
});

// The harness itself on the SQL lane: the world seeder must work in both id modes.
describe.each([
  { ids: "default ids", generateId: undefined },
  { ids: "uuid ids", generateId: "uuid" as const },
])("seedSupportWorld on PGlite ($ids)", ({ generateId }) => {
  it("creates the staff org with an id the database accepts", async () => {
    const staffOrganizationId = staffOrgIdFor(generateId);
    harness = await createSqlTestAuth({ staffOrganizationId }, { generateId });
    const world = await seedSupportWorld(harness.auth);
    expect(world.staffOrganizationId).toBe(staffOrganizationId);
    const staff = await harness.db
      .selectFrom("member")
      .select(["userId", "role"])
      .where("organizationId", "=", staffOrganizationId)
      .execute();
    expect(
      staff.find((m) => m.userId === world.agents.owner.user.id)?.role,
    ).toBe("owner");
    expect(staff.length).toBe(Object.keys(world.agents).length);
  });
});
