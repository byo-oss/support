# @byo-oss/support

Customer support as a better-auth plugin: tickets, replies, internal notes, canned replies, attachments, a customer widget and a staff inbox, with optional email in and out. `llms.txt` is the full usage reference; read it before wiring this into an app. The README has the schema, API table and exit path.

## Installing it in an app

The same steps, with checks, ship as a skill: `skills/support-setup/SKILL.md`. Keep the two in step when setup changes.

1. `npm install @byo-oss/support` (peer: `better-auth` `^1.7.7`; add `@wraps.dev/email` for `wrapsMailer`, `@aws-sdk/client-s3` for `s3Storage` and `wrapsInbound`).
2. Server plugins, in this order: `organization({ ac, roles })` **then** `support({ staffOrganizationId })`. `support()` throws at boot without `organization()`, and migrations create tables in plugin order, so `organization()` must come first.
3. Access control: import `supportStatements` and `supportRoles` from `@byo-oss/support/client` (browser-safe, for access files shared with the client), spread `supportStatements` into the app's `createAccessControl({ ...defaultStatements, ...supportStatements })` and add `supportRoles` to the staff roles (`ac.newRole({ ...ownerAc.statements, ...supportRoles.owner })`). Without it every agent endpoint answers `NOT_ALLOWED`. Agents are members of the staff organization (`staffOrganizationId`); a customer organization's owner is never an agent.
4. Run the app's migration (`npx @better-auth/cli migrate`, or regenerate drizzle/prisma). Run it again after setting `mailer` (adds `supportDelivery`) or `attachments` (adds `supportAttachment`). When generating, the auth config the CLI loads must set `mailer` and `attachments` like production, or those tables are missing from the generated schema.
5. Client: add `supportClient()` from `@byo-oss/support/client` to `createAuthClient({ plugins })`.
6. UI: render `<SupportWidget client={authClient} organizationId onNavigate />` for customers (a popover: put it at the right end of the header; `variant="inline"` for a page of its own) and `<SupportInbox client={authClient} agents onNavigate />` on a staff-only page, both from `@byo-oss/support/react`. `agents` is the staff organization's members whose role grants `support: ["read"]` (what `isAgent` checks), as `{ id, name, image? }`. Deep links: `ticketPath(id)` → a page with `<SupportWidget variant="inline" ticketId={id} />`; staff links → `<SupportInbox ticketId={id} onTicketChange={...} />` synced to the URL.
7. Tailwind v4: add `@source "<path>/node_modules/@byo-oss/support/dist";` to the CSS, or the components render unstyled. In a monorepo, `@byo-oss/support` must be a direct dependency of the web app's package.
8. Cron: call `auth.api.processSupportDeliveries({})` every minute (or `sweepAll(auth)` from `@byo-oss/core`), again while `hasMore`. Without it delayed replies and retries never go out, solved tickets never close and stale uploads are never pruned.
9. Email replies: `mailer` (for example `wrapsMailer` from `@byo-oss/support/wraps`) and `email: { from, replyDomain, appUrl }` together. Neither works alone.
10. Inbound email: `inbound: { source: rawRelay({ secret }) }` or `wrapsInbound({ key, bucket, region })`, with `email` set. The relay posts to `<auth base path>/support/inbound` and every address at `replyDomain` (plus-addresses too) must reach it. For `wrapsInbound`, grant the role `s3:GetObject` **and** `s3:ListBucket`: without `ListBucket` a missing object looks like `AccessDenied` and is retried forever, and filter the EventBridge rule on `detail.receivingDomain` (the `replyDomain`): one Wraps stack emits `email.received` for every domain it receives. DKIM verification needs Node's `dns`: no edge runtimes for this endpoint.
11. Organization hooks: nothing to wire for the organization plugin's own delete, remove-member and leave endpoints, because support cleans up after them (`organizationCleanup`, default `true`). For deletes made any other way call `deleteOrganizationData(auth, organizationId)` and `deleteMemberData(auth, { userId, organizationId })`, or `@byo-oss/core`'s fan-out.
12. Events: pass `onEvent` (build it with `createEventBus` from `@byo-oss/core`) and route events to `@byo-oss/notifications` (or the app's own notification layer): staff get `support.ticket.created`, `support.customer.replied` (recipients: staff-organization members whose role grants `support: ["read"]`, never a list of role names), `support.ticket.assigned` and `support.agent.mentioned`; the requester gets `support.agent.replied`. Never forward `support.note.added` to a customer.

## Rules

- Address people by better-auth `userId` and customer organizations by `organizationId`. Don't keep a separate requester or agent table.
- Don't query or write the plugin's tables from app code. Go through `auth.api.*`, the client, the hooks and the exported functions (`deleteOrganizationData`, `deleteMemberData`, `deleteSupportRequesterData`, `linkSupportRequester`, `exportSupportData`).
- Permissions, not role names: grant `support` actions through `supportStatements`, or replace `authorize`. Add credential rules (refuse API-key or bearer sessions) in `acceptSession`; the default refuses impersonated sessions.
- `replyToken` never leaves the server: not in an API response, not in an export, not in a log.
- Don't add `text/html`, `image/svg+xml` or `application/xhtml+xml` to `attachments.allowedTypes`; boot refuses them.
- A custom provider is a `Mailer`, a `SupportInboundSource` or a `SupportStorage`. Test it with `testMailer` (`@byo-oss/mailer/testing`), `testSupportInboundSource` and `testSupportStorage` (`@byo-oss/support/testing`, ESM only).
- Every UI string has a `labels` override; reach for it before forking a component.

## Working on this repo

- `pnpm install`, then the lanes:
  - `pnpm typecheck` and `pnpm lint` (biome).
  - `pnpm test`: the memory lane. Every behaviour test runs against a real better-auth instance on the memory adapter with the organization plugin (`src/test-utils.ts`). Its strict adapter wrapper fails a test on any support-model `findMany` without a `limit` and any `in` list with 0 or more than 90 values: use `chunk` and `findManyIn` from `src/adapter.ts`. Files named `*.sql.test.ts` and `*.dist.test.ts` are excluded.
  - `pnpm test:sql`: the SQL lane (`src/**/*.sql.test.ts`), on PGlite through Kysely (`src/test-sql.ts`). It covers what the memory adapter can't enforce: foreign keys and `onDelete`, unique constraints, list queries, concurrent numbering, Message-ID de-duplication and the README's uninstall list. Call `close()` in `afterEach`.
  - `pnpm test:dist`: run `pnpm build` first. It checks the built `dist/`: the root must import no provider SDK.
  - React tests (`*.test.tsx`) start with `// @vitest-environment happy-dom`.
- Every `findMany` passes an explicit `limit`. `in` lists are skipped when empty and chunked at 90 (Cloudflare D1's 100-parameter limit). Lists page with an `{ at, ids }` cursor on `lastMessageAt`, never `id > cursor`. No `where` list mixes `AND` and `OR` connectors.
- The root export never imports a provider SDK: `mailauth`, `postal-mime` and `@aws-sdk/client-s3` load with a dynamic `import()` only, and `@wraps.dev/email` is never imported here (`./wraps` re-exports the mailer's adapter).
- Errors are `APIError.from(status, SUPPORT_ERROR_CODES.X)`; input is zod with the limits in `SUPPORT_LIMITS` (`src/options.ts`).
- The schema is a public contract (README, Schema). A change that breaks reading existing rows is a major release. The README's uninstall `DROP TABLE` list must equal `UNINSTALL_DROP_ORDER` in `src/uninstall.sql.test.ts`, in the same order.
- A public change (exports, options, endpoints, error codes, schema, peer dependencies) updates `README.md`, `llms.txt` and `skills/support-setup/SKILL.md` in the same PR.
- Versioning is semver, `0.x` until the API settles. Publish `@byo-oss/mailer` and `@byo-oss/core` before this package when their API changed.
- Follow the BYO conventions: https://github.com/byo-oss/conventions/blob/main/SPEC.md
