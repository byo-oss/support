/**
 * Test harness for the SQL lane (`*.sql.test.ts`): a real better-auth on
 * PGlite through Kysely, migrated with better-auth's `getMigrations`. PGlite
 * rejects `IN ()`, applies `unique` and `onDelete`, and runs transactions.
 * One PGlite connection serializes queries, so code that uses the outer
 * adapter inside a transaction hangs here instead of passing.
 */

import { kyselyAdapter } from "@better-auth/kysely-adapter";
import { PGlite } from "@electric-sql/pglite";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { Kysely } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { type SupportOptions, support } from "./index";
import {
  mergeAuthOptions,
  type TestAuthConfig,
  testOrganization,
  wrapAdapterFactory,
} from "./test-utils";

export type SqlTestAuthConfig = TestAuthConfig & {
  /** better-auth's `advanced.database.generateId`. @default better-auth's own ids */
  generateId?: "uuid" | "serial";
};

/**
 * A migrated PGlite database and a `betterAuth` on it with
 * `organization({ ac, roles })`, `support(opts)` and the Kysely adapter
 * (`type: "postgres"`, `transaction: true`) behind the strict wrapper.
 * `config.adapter.before` runs before every adapter call, inside transactions
 * too: use it to force a conflict path deterministically. Call `close()` in
 * `afterAll`/`afterEach`.
 */
export async function createSqlTestAuth(
  opts: SupportOptions = {},
  config: SqlTestAuthConfig = {},
) {
  const pglite = new PGlite();
  // biome-ignore lint/suspicious/noExplicitAny: tables come from the migration, not a typed schema
  const db = new Kysely<any>({ dialect: new KyselyPGlite(pglite).dialect });
  const plugins = [
    ...(config.organization === false ? [] : [testOrganization()]),
    support(opts),
    ...(config.plugins ?? []),
  ];
  const advanced: BetterAuthOptions["advanced"] = {
    ...config.authOptions?.advanced,
    ...(config.generateId
      ? {
          database: {
            ...config.authOptions?.advanced?.database,
            generateId: config.generateId,
          },
        }
      : {}),
  };
  const options = {
    ...mergeAuthOptions(config.authOptions),
    advanced,
    plugins,
  };
  // getMigrations needs the object form of `database`; the auth below uses a
  // wrapped adapter factory on the same Kysely instance
  const { runMigrations } = await getMigrations({
    ...options,
    database: { db, type: "postgres" },
  });
  await runMigrations();
  const auth = betterAuth({
    ...options,
    database: wrapAdapterFactory(
      kyselyAdapter(db, { type: "postgres", transaction: true }),
      config.adapter,
    ),
  });
  return {
    auth,
    /** Raw SQL access to the same database. */
    db,
    pglite,
    close: async () => {
      await db.destroy();
    },
  };
}

export type SqlTestAuth = Awaited<ReturnType<typeof createSqlTestAuth>>["auth"];
