import { PGlite } from "@electric-sql/pglite";
import { Kysely, sql } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { afterAll, expect, it } from "vitest";

const pglite = new PGlite();
const db = new Kysely<Record<string, never>>({
  dialect: new KyselyPGlite(pglite).dialect,
});

afterAll(async () => {
  await db.destroy();
});

it("runs SQL against PGlite through Kysely", async () => {
  const result = await sql<{ one: number }>`select 1 as one`.execute(db);
  expect(result.rows[0]?.one).toBe(1);
});
