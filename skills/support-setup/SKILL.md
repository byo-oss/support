---
name: support-setup
description: Customer support for better-auth apps with @byo-oss/support. Use when adding a support widget or ticket inbox, letting customers open tickets in-app or by email, giving staff a shared queue, wiring support email (replies and inbound), attachments, org cleanup or notifications for support events, or exporting and uninstalling support data.
---

# @byo-oss/support

A better-auth plugin: tickets, messages and canned replies are rows in the app's own database, requesters are better-auth users, staff are members of one organization, and a React widget and inbox sit on top. Email in and out, attachments and events are opt-in.

The API reference is `node_modules/@byo-oss/support/llms.txt` once the package is installed, and the README has the schema and the exit path. Read them before writing calls; this skill covers the multi-file wiring and the gotchas.

## Setup

Work through these in order. Each step ends on a check; move on only when it holds.

1. **Install.** `npm install @byo-oss/support` (use the repo's package manager). Add `@wraps.dev/email` only for `wrapsMailer`, and `@aws-sdk/client-s3` only for `s3Storage` or `wrapsInbound`. Done when it's in the dependencies of the package that holds the better-auth config, and of the web app if that's a separate package.

2. **Staff organization.** Staff are members of one organization. Use the existing one for the vendor's team or create it, and put its id in config (`SUPPORT_STAFF_ORGANIZATION_ID`). Done when you can name the organization id and its members.

3. **Access control.** The organization plugin's default roles have no `support` actions. In the file that builds the app's `createAccessControl`, spread `supportStatements` from `@byo-oss/support` next to `defaultStatements`, and add `supportRoles.owner`, `.admin` and `.member` to the matching `ac.newRole({ ...ownerAc.statements, ...supportRoles.owner })`. Done when the roles typecheck and a staff role includes `support`.

4. **Server plugins, in order.** In `betterAuth({ plugins })`: `organization({ ac, roles })`, **then** `support({ staffOrganizationId })`. If the order is reversed the migration can't create `supportTicket` (it references `organization`); if `organization()` is missing, boot throws `ORGANIZATION_PLUGIN_REQUIRED`. Done when the app boots without the "every agent endpoint will deny" warning.

5. **Migration.** `npx @better-auth/cli migrate`, or `npx @better-auth/cli generate` then the repo's drizzle or prisma flow. It adds `supportTicket`, `supportCounter`, `supportTicketTag`, `supportMessage` and `supportCannedReply` (and `supportDelivery` and `supportAttachment` once their options are set; rerun it then), with nothing on better-auth's own tables. On MongoDB also create unique indexes on `supportCounter.key`, `supportTicket.number`, `supportTicket.replyToken` and `supportMessage.emailMessageId`. Done when the migration is applied to the dev database.

6. **Client plugin.** Add `supportClient()` from `@byo-oss/support/client` to `createAuthClient({ plugins })`. Done when `authClient.support.myTickets` and `authClient.support.agent.tickets` typecheck.

7. **Components.** From `@byo-oss/support/react`:
   - `<SupportWidget client={authClient} organizationId={activeOrganizationId} onNavigate={...} />` once, where signed-in customers ask for help. `organizationId` is the customer's own organization, so tickets can be shared with teammates.
   - `<SupportInbox client={authClient} agents={agents} onNavigate={...} />` on a staff-only page. `agents` is the staff organization's members as `{ id, name, image? }`; the plugin doesn't enumerate staff.
   - `onNavigate` takes the app router (Next.js `(href) => router.push(href)`, TanStack Router `(href) => router.navigate({ href })`).
   - Tailwind v4 skips `node_modules`: add `@source "<relative path>/node_modules/@byo-oss/support/dist";` to the CSS file that imports Tailwind.

   Done when a customer can open a ticket, an agent with a staff role sees it in the inbox, replies, and the customer sees the reply.

8. **Cron.** Add a scheduled call to `auth.api.processSupportDeliveries({})` every minute, in whatever runs the app's cron (call it again while `hasMore`), or `sweepAll(auth)` from `@byo-oss/core` if several BYO plugins are installed. Protect the route. It is required even without email: the sweep closes solved tickets after `autoCloseAfter` and prunes stale uploads. Done when a call returns `{ sent, skipped, retrying, failed, hasMore, closed, pruned }`.

## Add-ons, only if asked for

**Email replies.** Needs `@wraps.dev/email` for Wraps. Add `mailer: wrapsMailer({ from })` (from `@byo-oss/support/wraps`) and `email: { from, replyDomain, appUrl }` together, with `from` the same address; setting one without the other fails at boot. Route `ticketPath(id)` (default `/support/<id>`) to the widget so the link in mail lands. Rerun the migration (adds `supportDelivery`). Done when an agent reply produces a `sent` row in `supportDelivery` after the sweep runs.

**Inbound email.** Needs `email`. Add `inbound: { source: rawRelay({ secret }) }` (Postmark, Mailgun, Cloudflare: POST the raw message with `Authorization: Bearer <secret>`) or `wrapsInbound({ key, bucket, region })` from `@byo-oss/support/wraps` (EventBridge `email.received`, header `X-Wraps-Inbound-Key`). Point the relay at `<auth base path>/support/inbound` and route every address at `replyDomain`, plus-addresses included, to it.
- For `wrapsInbound` the role needs `s3:GetObject` on `bucket/*` **and** `s3:ListBucket` on the bucket. Without `ListBucket` a missing object is reported as `AccessDenied`, answered 502 and retried forever.
- DKIM is verified through Node's `dns`: don't deploy this endpoint to an edge runtime.
- The endpoint answers 202 for everything it took, so the relay stops retrying; 401 means the secret is wrong.

Done when a mail to `support@<replyDomain>` opens a ticket and a mail to a reply address (`support+<token>@<replyDomain>`) from the requester appends to it.

**Attachments.** Add `attachments: { storage: s3Storage({ bucket, region }) }` from `@byo-oss/support/s3` (role: `s3:PutObject`, `GetObject`, `DeleteObject`, `ListBucket`), rerun the migration (adds `supportAttachment`). Defaults: 10 MiB, png, jpeg, gif, webp, pdf, plain text, csv, zip; never HTML, SVG or XHTML. Done when a file uploaded in the widget can be attached to a reply and downloaded by the agent.

**Org cleanup.** Support cleans up after the organization plugin's `/organization/delete`, `/remove-member` and `/leave` by itself (`organizationCleanup`, default `true`). For deletes made another way, call `deleteOrganizationData(auth, organizationId)` and `deleteMemberData(auth, { userId, organizationId })` from `@byo-oss/support`, or `@byo-oss/core`'s fan-out in `organizationHooks`. Done when deleting a test organization leaves no tickets for it.

**Notifications.** Pass `onEvent` built with `createEventBus` from `@byo-oss/core` and route to `auth.api.notify` (`@byo-oss/notifications`): `support.ticket.created`, `support.customer.replied` to the staff organization (`organizationId: staffOrganizationId`, `excludeUserIds` the actor); `support.ticket.assigned` and `support.agent.mentioned` to `event.userId`; `support.agent.replied` to the requester's `event.userId`. Never forward `support.note.added` to a customer. Done when an agent reply shows up in the customer's inbox.

## Rules

- `organization()` before `support()`. Always.
- Permissions, not role names. Grant `support` actions through `supportStatements`, or replace `authorize`. Refuse API-key or bearer sessions in `acceptSession`; the default only refuses impersonated sessions.
- App code reaches the package through `auth.api.*`, the client, the React exports and the exported functions. Leave its tables to it, and never expose `replyToken`.
- Errors carry a code from `SUPPORT_ERROR_CODES` (`TICKET_NOT_FOUND`, `NOT_ALLOWED`, `SESSION_NOT_ACCEPTED`, and so on); branch on the code, not the message.
- Every UI string has a `labels` override; reach for it before forking a component.
- Leaving: `exportSupportData(auth, { cursor })` pages everything out (loop until `cursor` is `null`). Uninstalling is documented in the README: remove the plugin, drop the tables in the documented order, delete the `support/` storage prefix.

## Custom providers

A `Mailer` (`@byo-oss/mailer`) resolves `{ id, messageId? }`, throws to retry and throws `PermanentMailError` to fail at once. A `SupportInboundSource` is `{ receive(request) }` resolving `{ raw }` or `{ reject: status }` (401 bad secret, 404 gone for good, 413 too large, 5xx to retry). A `SupportStorage` is `{ put, get, delete, deletePrefix }` that throws to fail. Test them (vitest, ESM):

```ts
import { testSupportInboundSource, testSupportStorage } from "@byo-oss/support/testing"
testSupportStorage(() => myStorage({ client: fake }), { failing: () => myStorage({ client: rejecting }) })
```

Done when the suite passes.
