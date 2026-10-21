// PRD acceptance #19: the README's uninstall drop list, run in order on a
// migrated database (PGlite, foreign keys on).
import { memoryMailer } from "@byo-oss/mailer";
import { sql } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import type { SupportOptions, SupportStorage } from "./options";
import { createSqlTestAuth } from "./test-sql";
import {
  getContext,
  insertMessage,
  insertTag,
  insertTicket,
  STAFF_ORG_ID,
  seedSupportWorld,
} from "./test-utils";

// The README's drop block is diffed against this list: keep it a plain array
// literal, children before the tables they reference.
const UNINSTALL_DROP_ORDER = [
  "supportAttachment",
  "supportDelivery",
  "supportMessage",
  "supportTicketTag",
  "supportCannedReply",
  "supportTicket",
  "supportCounter",
];

// migrating and seeding PGlite takes seconds, more when files run side by side
const SQL_TIMEOUT = 30_000;

const BETTER_AUTH_TABLES = ["user", "organization", "member", "session"];

const storage: SupportStorage = {
  put: async () => {},
  get: async () => null,
  delete: async () => {},
  deletePrefix: async () => {},
};

const WITH_OPTIONAL: SupportOptions = {
  mailer: memoryMailer(),
  email: {
    from: "Support <support@vendor.test>",
    replyDomain: "reply.vendor.test",
    appUrl: "https://app.vendor.test",
  },
  attachments: { storage },
};

type Harness = Awaited<ReturnType<typeof createSqlTestAuth>>;
let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function tableNames(h: Harness): Promise<string[]> {
  const { rows } = await sql<{ table_name: string }>`
    select table_name from information_schema.tables
    where table_schema = 'public' order by table_name
  `.execute(h.db);
  return rows.map((row) => row.table_name);
}

async function rowCounts(h: Harness) {
  const counts: Record<string, number> = {};
  for (const table of BETTER_AUTH_TABLES) {
    const { rows } = await sql<{ n: number }>`
      select count(*)::int as n from ${sql.table(table)}
    `.execute(h.db);
    counts[table] = rows[0]?.n ?? -1;
  }
  return counts;
}

/** People, organizations and sessions, plus a row in every support table. */
async function seed(h: Harness, optional: boolean) {
  const world = await seedSupportWorld(h.auth);
  const { adapter } = await getContext(h.auth);
  const ticket = await insertTicket(h.auth, {
    userId: world.customer.user.id,
    organizationId: world.customerOrg.id,
    assigneeId: world.agents.admin.user.id,
  });
  await insertTicket(h.auth, { mergedIntoId: ticket.id });
  const message = await insertMessage(h.auth, {
    ticketId: ticket.id,
    userId: world.customer.user.id,
  });
  await insertTag(h.auth, { ticketId: ticket.id, tag: "billing" });
  await adapter.create({
    model: "supportCannedReply",
    data: {
      title: "Hi",
      body: "Hello there",
      userId: world.agents.admin.user.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });
  if (!optional) return;
  await adapter.create({
    model: "supportDelivery",
    data: {
      messageId: message.id,
      ticketId: ticket.id,
      status: "pending",
      scheduledFor: new Date(),
      attempts: 0,
      createdAt: new Date(),
    },
  });
  await adapter.create({
    model: "supportAttachment",
    data: {
      ticketId: ticket.id,
      messageId: message.id,
      userId: world.customer.user.id,
      internal: false,
      filename: "shot.png",
      contentType: "image/png",
      size: 1,
      storageKey: `support/${world.customerOrg.id}/blob`,
      createdAt: new Date(),
    },
  });
}

describe.each([
  { tables: "with the optional tables", optional: true },
  { tables: "without the optional tables", optional: false },
])("uninstall on PGlite ($tables)", ({ optional }) => {
  it(
    "drops every support table in the documented order and leaves better-auth's tables intact",
    async () => {
      harness = await createSqlTestAuth({
        staffOrganizationId: STAFF_ORG_ID,
        ...(optional ? WITH_OPTIONAL : {}),
      });
      await seed(harness, optional);
      const support = (await tableNames(harness)).filter((t) =>
        t.startsWith("support"),
      );
      expect(support.sort()).toEqual(
        UNINSTALL_DROP_ORDER.filter(
          (t) =>
            optional || (t !== "supportAttachment" && t !== "supportDelivery"),
        ).sort(),
      );
      const before = await rowCounts(harness);
      for (const count of Object.values(before))
        expect(count).toBeGreaterThan(0);

      // no CASCADE: the order alone has to satisfy the foreign keys
      for (const table of UNINSTALL_DROP_ORDER) {
        await sql`drop table if exists ${sql.table(table)}`.execute(harness.db);
      }

      const after = await tableNames(harness);
      expect(
        after.filter((t) => t.toLowerCase().startsWith("support")),
      ).toEqual([]);
      for (const table of BETTER_AUTH_TABLES) expect(after).toContain(table);
      expect(await rowCounts(harness)).toEqual(before);
    },
    SQL_TIMEOUT,
  );
});

it(
  "needs the order: a table goes only after the tables that reference it",
  async () => {
    harness = await createSqlTestAuth(
      { staffOrganizationId: STAFF_ORG_ID, ...WITH_OPTIONAL },
      {},
    );
    await seed(harness, true);

    await expect(
      sql`drop table if exists ${sql.table("supportTicket")}`.execute(
        harness.db,
      ),
    ).rejects.toThrow(/depend/);
    expect(await tableNames(harness)).toContain("supportTicket");
  },
  SQL_TIMEOUT,
);
