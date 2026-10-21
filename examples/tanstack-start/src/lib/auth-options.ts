import { DatabaseSync } from "node:sqlite";
import type { BetterAuthOptions } from "better-auth";
import { organization } from "better-auth/plugins/organization";
import { memoryMailer } from "@byo-oss/mailer";
import { support } from "@byo-oss/support";
import { ac, roles } from "./access.ts";
import { STAFF_ORGANIZATION_ID } from "./constants.ts";

/** Mail the plugin would send, kept in memory. Swap for `wrapsMailer(...)`. */
export const mailer = memoryMailer();

// Shared with scripts/migrate.ts and scripts/seed.ts, which run under plain
// Node and so can't import the TanStack cookie plugin.
export const authOptions = {
  // node:sqlite ships with Node; better-auth's Kysely adapter takes it as is
  database: new DatabaseSync(process.env.DB_PATH ?? "./example.db"),
  emailAndPassword: { enabled: true },
  plugins: [
    organization({ ac, roles }), // before support()
    support({
      staffOrganizationId: STAFF_ORGANIZATION_ID,
      mailer,
      email: {
        from: "Example Support <support@example.dev>",
        replyDomain: "support.example.dev",
        appUrl: "http://localhost:3000",
        // links in support mail open the ticket in the widget on /help
        ticketPath: (id) => `/help?ticket=${id}`,
        replyDelay: 0,
        // the seeded customer has no verified address
        requireVerifiedEmail: false,
      },
    }),
  ],
} satisfies BetterAuthOptions;
