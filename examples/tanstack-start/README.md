# @byo-oss/support × TanStack Start

TanStack Start + better-auth (SQLite via `node:sqlite`) + `@byo-oss/support`, with an
end-to-end suite that proves the wiring: a customer opens a ticket from the widget, an
agent answers it in the inbox, the customer solves it.

Needs Node 22.13+ (for `node:sqlite` and running `.ts` scripts; 22.18+ strips types by default).

```
pnpm install
pnpm migrate     # creates example.db (better-auth + support tables)
pnpm seed        # staff organization, an agent and a customer
pnpm dev         # http://localhost:3000
```

Sign in as the customer (`customer@example.dev` / `customer-password-123`), open **Help**,
press **Support** and create a ticket. Sign out, sign in as the agent
(`agent@example.dev` / `agent-password-123`), open **Inbox** and reply.

## Where the pieces are

- `src/lib/access.ts`: `supportStatements` spread into the access control, `supportRoles` into the roles.
- `src/lib/auth-options.ts`: `organization({ ac, roles })` then `support({ staffOrganizationId, mailer, email })`.
  Shared with `scripts/migrate.ts` and `scripts/seed.ts`, which run under plain Node.
- `src/lib/auth.ts`: adds `tanstackStartCookies()` last, for server functions.
- `src/lib/auth-client.ts`: `supportClient()`.
- `src/routes/help.tsx`: `<SupportWidget client={authClient} ticketId={ticket} />` for signed-in customers.
  `?ticket=<id>` opens that ticket's thread, which is where reply emails link (`ticketPath` in `auth-options.ts`).
- `src/routes/inbox.tsx`: `<SupportInbox client={authClient} agents={agents} />`. `agents` are the
  staff organization's members, loaded by the server function in `src/lib/agents.ts`.
- `src/routes/api/cron/support.ts`: the sweep (`sweepAll` from `@byo-oss/core`). Delayed replies are
  only mailed when something calls it; point a scheduler at it every minute.
- `scripts/seed.ts`: creates the staff organization with the fixed id `staff-org`, which the plugin
  is told about, and makes the agent its owner (`supportRoles.owner` has every support action).

Replies are mailed through `memoryMailer()`, so nothing leaves the machine. Swap in
`wrapsMailer(...)` from `@byo-oss/support/wraps` to send for real.

The components use shadcn CSS variables and Tailwind classes. This example doesn't set Tailwind
up, so they render unstyled. With Tailwind v4, add the `@source` line from the package README.

## Packed tarballs

`pnpm-workspace.yaml` overrides the three `@byo-oss/*` packages to `.tarballs/*.tgz`, packed from the
package's checkout, so the example runs against what would be published. Pack them into `.tarballs/`
(git-ignored) before `pnpm install`. To use the published packages, delete the `overrides` block.

## End-to-end tests

`tests/support.e2e.ts` runs on [e2e](https://www.npmjs.com/package/e2e), with no agent steps, so it
needs no model or API key:

```
npx e2e-web install chromium   # once
pnpm test:e2e
```

The runner starts the app on a free port against a fresh `e2e.db` (migrated and seeded by
`e2e:serve`). It checks the whole loop: customer signs in and opens a ticket, agent signs in, sees it
and replies, the sweep mails the reply, the customer sees it and marks the ticket solved.

e2e needs Node 22.22.3+ or 24.8+.
