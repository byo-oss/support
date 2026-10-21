# @byo-oss/support

Customer support for [better-auth](https://better-auth.com) apps: tickets, replies, internal notes, canned replies and attachments in **your** database, an in-app widget for customers and an inbox for your staff, and email in and out when you want it.

> Community plugin — not affiliated with the better-auth team.

```
npm install @byo-oss/support
```

- **Your users, your organizations, your permissions.** Tickets belong to better-auth users. A customer can share a ticket with their organization. Your staff are members of one organization you choose, with roles you control through better-auth's access control.
- **One plugin, one migration, two components.** `SupportWidget` for customers, `SupportInbox` for agents, both on headless hooks you can use instead.
- **Email when you want it.** Agent replies are mailed to the requester through a `Mailer` ([Wraps](https://wraps.dev) on your own AWS SES account, or your own). Mail sent to your support address opens or continues a ticket, with an aligned-DKIM check.
- **Events, not a notification system.** Every change emits an event; route them to staff and customers through [`@byo-oss/notifications`](https://github.com/byo-oss/notifications) or anything else.
- **A way out.** `exportSupportData`, a documented schema and a clean uninstall are part of the package. See [Outgrowing this](#outgrowing-this).

## Install

```
npm install @byo-oss/support
```

Requires Node 20 or newer, `better-auth` `^1.7.7` (1.6 is not supported: its plugin API differs), `@better-auth/core` at the same version as `better-auth` (better-auth already depends on it; install it yourself when your package manager is strict about peers) and `zod` `^4.0.0`. `zod` is a peer dependency, so support validates with your app's copy instead of bringing its own; npm and pnpm install it when your app doesn't list it (better-auth already depends on zod 4), and with Yarn you add it yourself. An app still on zod 3 has to move to zod 4 first (npm stops with `ERESOLVE`). The better-auth `organization` plugin is required: the schema references `organization`, and your staff are an organization's members.

Optional peers, each behind its own import so the root never loads them:

| Package | Needed for |
|---|---|
| `react` (>=18) | `@byo-oss/support/react` |
| `@wraps.dev/email` | `wrapsMailer` from `@byo-oss/support/wraps` |
| `@aws-sdk/client-s3` | `s3Storage` from `@byo-oss/support/s3`, and `wrapsInbound` |
| `vitest` | `@byo-oss/support/testing` (ESM only) |

In a monorepo, add `@byo-oss/support` as a direct dependency of the web app's package (not only of a shared server package): the app imports `@byo-oss/support/react`, and Tailwind's `@source` path points into that package's `node_modules`.

The `Mailer` type comes from [`@byo-oss/mailer`](https://github.com/byo-oss/mailer), which is a dependency of this package. Install it yourself if you import `memoryMailer` or `PermanentMailError` from it.

## Setup

Five steps give you customers opening and following tickets (in-app, with polling) and agents working one queue: reply or leave a note, set status, priority, assignee and tags, in bulk. Email, inbound mail and attachments are [add-ons](#email-replies) further down.

1. **Add the plugins.** `organization()` must come before `support()`: migrations create tables in plugin order, and `supportTicket` references `organization`. Create one organization for your team (the staff organization; see [Seed the staff organization](#seed-the-staff-organization)) and pass its id:

   ```ts
   // lib/auth.ts
   import { betterAuth } from "better-auth";
   import { organization } from "better-auth/plugins/organization";
   import { support } from "@byo-oss/support";
   import { ac, roles } from "./access"; // step 2

   export const auth = betterAuth({
     // ...your existing config
     plugins: [
       organization({ ac, roles }), // before support()
       support({ staffOrganizationId: process.env.SUPPORT_STAFF_ORGANIZATION_ID }),
     ],
   });
   ```

   Without `staffOrganizationId` (and without your own `authorize`), every agent endpoint denies and the server logs one warning at boot. Pass `staffOrganizationId: null` to run without agents on purpose (no warning). If the id is only known after boot, pass a function, `() => id | null | undefined`: it is called on every request that needs it.

2. **Grant staff the `support` actions.** The organization plugin's default roles have none. Spread `supportStatements` into your access control and add `supportRoles` to the roles you create. Import both from `@byo-oss/support/client`: access files are often shared with browser code, and that entry loads none of the server's mail parsing (the root exports them too). Agents are members of the staff organization whose role has them; a customer organization's owner is never an agent.

   ```ts
   // lib/access.ts
   import { createAccessControl } from "better-auth/plugins/access";
   import {
     adminAc,
     defaultStatements,
     memberAc,
     ownerAc,
   } from "better-auth/plugins/organization/access";
   import { supportRoles, supportStatements } from "@byo-oss/support/client";

   export const ac = createAccessControl({ ...defaultStatements, ...supportStatements });

   export const roles = {
     owner: ac.newRole({ ...ownerAc.statements, ...supportRoles.owner }),
     admin: ac.newRole({ ...adminAc.statements, ...supportRoles.admin }),
     member: ac.newRole({ ...memberAc.statements, ...supportRoles.member }),
   };
   ```

   `support` has five actions: `read` (the queue and any ticket), `reply` (agent replies and notes), `update` (status, priority, assignee, tags, bulk update, merge), `manage` (canned replies) and `delete` (delete tickets). `supportRoles` suggests `owner` and `admin` get all five and `member` gets `read`, `reply` and `update`; grant each role, custom roles included, only the actions its staff need. Roles apply in every organization, but support checks them only in the staff organization, so only that organization's members become agents: a customer organization's `owner` holding `support` actions in its own organization changes nothing. Support checks permissions, never role names.

3. **Run the migration.** The plugin declares its tables; your existing better-auth workflow creates them:

   ```
   npx @better-auth/cli migrate   # or: generate, for drizzle/prisma
   ```

   If your framework's auth config can't be loaded by the CLI, run the same migration from code with `getMigrations` from `better-auth/db/migration`:

   ```ts
   import { getMigrations } from "better-auth/db/migration";
   import { auth } from "./lib/auth";

   const { runMigrations } = await getMigrations(auth.options);
   await runMigrations();
   ```

   It adds `supportTicket`, `supportCounter`, `supportTicketTag`, `supportMessage` and `supportCannedReply`, plus `supportDelivery` once you set `mailer` and `supportAttachment` once you set `attachments` (run it again after you turn those on). Nothing is added to `user`, `organization` or `member`.

   Because those two tables follow the options, a generated schema (drizzle or prisma through the better-auth CLI) only has them if the auth config the CLI loads passes `mailer` and `attachments` the way production does; a CLI-only config without them generates a schema that lacks them. No support table references itself, so the generated drizzle schema typechecks under `strict`.

4. **Add the client plugin:**

   ```ts
   // lib/auth-client.ts
   import { createAuthClient } from "better-auth/react";
   import { supportClient } from "@byo-oss/support/client";

   export const authClient = createAuthClient({
     plugins: [supportClient()],
   });
   ```

5. **Render the components.** The widget goes at the right end of your header, for signed-in customers; the inbox goes on a staff-only page:

   ```tsx
   "use client";
   import { SupportInbox, SupportWidget } from "@byo-oss/support/react";
   import { useRouter } from "next/navigation";
   import { authClient } from "@/lib/auth-client";

   export function HeaderSupport({ organizationId }: { organizationId?: string }) {
     const router = useRouter();
     // organizationId: the customer's active organization, so tickets can be shared with teammates
     return (
       <SupportWidget
         client={authClient}
         organizationId={organizationId}
         onNavigate={(href) => router.push(href)}
       />
     );
   }

   export function StaffQueue({ agents }: { agents: { id: string; name: string; image?: string | null }[] }) {
     const router = useRouter();
     // agents: staff-organization members whose role grants support:read, for the assignee and @mention pickers
     return <SupportInbox client={authClient} agents={agents} onNavigate={(href) => router.push(href)} />;
   }
   ```

   `onNavigate` takes your router: `router.push(href)` as above, or `navigate({ href })` with TanStack Router. Without it, links to your app inside messages use `location.assign`. Build `agents` from the staff organization's members whose role grants `support: ["read"]`, on the server or in the browser (see [Staff list](#staff-list-agents)).

   Tailwind v4 skips `node_modules` when it scans for classes, so point it at the package or some classes won't be generated (see [Tailwind](#tailwind)). Polling pauses while the tab is hidden (see [Polling](#polling) for the cost), and every string has a `labels` override. The widget is a popover for your header; for a page of its own, and for email and notification links, see [Components](#components).

Server code can open a ticket without the widget too: `await auth.api.createSupportTicket({ headers, body: { subject, body } })`.

For a complete, runnable wiring, see the example app in [`examples/tanstack-start`](https://github.com/byo-oss/support/tree/main/examples/tanstack-start): TanStack Start with better-auth on SQLite and an end-to-end suite. Run it with `pnpm install`, `pnpm migrate`, `pnpm seed` and `pnpm dev` from that directory (Node 22.13 or newer); its README has the details and the sign-ins.

## For coding agents

[`AGENTS.md`](https://github.com/byo-oss/support/blob/main/AGENTS.md) has the install steps, rules and repo conventions, and [`llms.txt`](llms.txt) is the full usage reference. The same setup, with a check after each step, ships as a skill: [`skills/support-setup/SKILL.md`](skills/support-setup/SKILL.md).

## Options

`support(options)`. Every option is optional; with none, nothing sends or receives email and nothing is stored outside your database.

| Option | Type | Default | Notes |
|---|---|---|---|
| `staffOrganizationId` | string \| `null` \| `() => string \| null \| undefined` | | The vendor's staff organization. Agents are its members whose role has `support` actions. A function is called on every request that needs the id (the default `authorize` and `isAgent`, and the staff check when a member leaves); it must be synchronous and must not throw (an `async` function is refused at boot; a function that throws or returns anything but a string, `null` or `undefined`, such as a Promise, counts as no staff organization and is logged once). `null`: no agents, on purpose (a custom `authorize` still decides, with `organizationId` undefined; pass `isAgent` too, or assignment and @mentions fail with `NOT_AN_AGENT`); unset: the same plus one warning at boot |
| `authorize` | `({ session, headers, organizationId, permissions }) => boolean \| Promise<boolean>` | staff-organization check | Replaces the permission check on every agent endpoint. `organizationId` is always `staffOrganizationId` (as resolved for the request), never a ticket's organization. `permissions` is e.g. `{ support: ["reply"] }`. Without a staff organization (`null`), pass `isAgent` as well: the default looks in the staff organization, so every assignment and @mention would fail with `NOT_AN_AGENT` |
| `acceptSession` | `({ session, headers, kind }) => boolean \| Promise<boolean>` | refuses impersonated sessions | Called first on every session endpoint; `kind` is `"customer"` or `"agent"`. `false` answers 403 `SESSION_NOT_ACCEPTED` |
| `isAgent` | `(userId) => boolean \| Promise<boolean>` | member of the staff organization whose role has `support: ["read"]` | Who can be assigned a ticket or @mentioned. Anyone else is `NOT_AN_AGENT` |
| `mailer` | `Mailer` | | Sends thread mail to requesters. Requires `email`. Unset: no outbound mail and no `supportDelivery` table |
| `email` | `{ from, replyDomain, appUrl, ticketPath?, replyDelay?, requireVerifiedEmail? }` | | Required with `mailer` and with `inbound` |
| `email.from` | string | required | Sender of thread mail, e.g. `"Acme Support <support@acme.com>"`. Mail from this address is dropped as a loop |
| `email.replyDomain` | string | required | Replies go to `support+<token>@<replyDomain>`. A domain, not an address. Mail from any address on it is dropped as a loop |
| `email.appUrl` | string | required | Your app's origin, for the ticket link in mail |
| `email.ticketPath` | `(id) => string` | `` (id) => `/support/${id}` `` | Path of a ticket in your app. Set it if the default could collide with your routes (a top-level `/:org` segment, for example) |
| `email.replyDelay` | number (ms) | `120000` | Delay before an agent reply is mailed. Skipped if the requester saw the reply first. `0` sends at once; must be 0 or more |
| `email.requireVerifiedEmail` | boolean | `true` | Mail account holders only at a verified address |
| `inbound` | `{ source, newTickets?, maxPerSenderPerHour?, maxUnverifiedPerHour?, maxBytes?, resolver? }` | | Receive email at `/support/inbound`. Requires `email` |
| `inbound.source` | `SupportInboundSource` | required | `rawRelay(...)` or `wrapsInbound(...)` |
| `inbound.newTickets` | boolean | `true` | Open a new ticket for mail that doesn't thread. A requester's reply to a closed ticket still opens its follow-up |
| `inbound.maxPerSenderPerHour` | number | `20` | Verified email replies stored per sender in the last hour before more are dropped |
| `inbound.maxUnverifiedPerHour` | number | `100` | Unverified messages stored in the last hour, across all senders, before more are dropped |
| `inbound.maxBytes` | number | `26214400` (25 MiB) | Largest raw message accepted |
| `inbound.resolver` | `DkimResolver`: `(name, rrtype) => Promise<string[] \| string[][]>` | system DNS | DNS TXT lookups for the DKIM check, for tests and custom DNS. Serve a test key from it to test inbound threading without patching `node:dns` (see [Inbound email](#inbound-email)) |
| `attachments` | `{ storage, maxBytes?, allowedTypes? }` | | Enable attachments. Unset: no `supportAttachment` table, uploads answer `STORAGE_NOT_CONFIGURED` |
| `attachments.storage` | `SupportStorage` | required | `s3Storage(...)`, or your own |
| `attachments.maxBytes` | number | `10485760` (10 MiB) | Largest upload |
| `attachments.allowedTypes` | string[] | png, jpeg, gif, webp, pdf, plain text, csv, zip | Allowed content types. HTML, SVG and XHTML are refused at boot even if listed |
| `onEvent` | `(event: ByoEvent) => void \| Promise<void>` | | Receives every support event, after the write commits. Errors are logged, never thrown. See [Events](#events-to-notifications) |
| `organizationCleanup` | boolean | `true` | Clean up after the organization plugin's delete, remove-member and leave endpoints. Turn off to keep history. See [Lifecycle](#lifecycle) |
| `autoCloseAfter` | number (ms) | `604800000` (7 days) | The sweep closes tickets solved this long ago |
| `maxAttempts` | number | `5` | Attempts per delivery before it is marked `failed` |
| `batchSize` | number | `100` | Deliveries per sweep (and tickets auto-closed per sweep) |
| `leaseMs` | number (ms) | `300000` (5 min) | A claimed delivery older than this is presumed dead and retried |
| `pageSize` | number | `25` | Tickets per list page, 1 to 50 |
| `schema` | | | Rename tables and fields |

Boot validation throws a `[@byo-oss/support] …` error for: a `staffOrganizationId` that isn't a string, `null` or a function (or is an `async` function), `mailer` without `email` (or `email` without `mailer`), `inbound` without `email`, `inbound` without `source`, `attachments` without `storage`, a negative `replyDelay`, a `replyDomain` that contains `@`, `pageSize` over 50, an option that must be a whole number but isn't (or is below its minimum: 0 for `autoCloseAfter`, `inbound.maxPerSenderPerHour` and `inbound.maxUnverifiedPerHour`, 1 for `maxAttempts`, `batchSize`, `leaseMs`, `pageSize`, `inbound.maxBytes` and `attachments.maxBytes`), and `allowedTypes` containing `text/html`, `image/svg+xml` or `application/xhtml+xml`. A missing `organization()` plugin throws an `Error` whose message contains `ORGANIZATION_PLUGIN_REQUIRED`.

### Seed the staff organization

better-auth's `createOrganization` can't set an id, so to give the staff organization a fixed id (to keep in config) create it through the adapter, plus a `member` row that makes someone its owner. Run it once, for example from a seed script:

```ts
const ctx = await auth.$context;
const staffOrganizationId = "staff"; // what you pass as staffOrganizationId

await ctx.adapter.create({
  model: "organization",
  forceAllowId: true,
  data: { id: staffOrganizationId, name: "Support team", slug: "support-team", createdAt: new Date() },
});
await ctx.adapter.create({
  model: "member",
  data: { organizationId: staffOrganizationId, userId: ownerUserId, role: "owner", createdAt: new Date() },
});
```

The owner role has every `support` action once step 2 is done. The other route is to create the organization the normal way, from your admin UI or `auth.api.createOrganization`, and put the id it gets in `SUPPORT_STAFF_ORGANIZATION_ID`.

## Access

- **Agents.** Agent endpoints call `authorize` with `{ organizationId: staffOrganizationId, permissions: { support: [...] } }`. The default looks up the caller's `member` row in the staff organization and asks the organization plugin whether the role grants the action. It works whether or not the staff organization is the session's active one.
- **Customers.** A customer sees a ticket if they are its requester, or it is shared with an organization (`visibility: "organization"`) they are a current member of. A requester who leaves the organization keeps their own tickets; teammates lose the shared ones at once. A teammate can read and reply and upload, nothing else. Only the requester can solve, reopen, rate, share or mark a ticket seen.
- **Sessions.** `acceptSession` runs first on every session endpoint. The default refuses sessions an admin is impersonating, reads included. Add your own credential rules, for example to refuse API-key or bearer sessions:

  ```ts
  support({
    acceptSession: ({ session, headers }) =>
      !session.session.impersonatedBy && !headers.get("authorization")?.startsWith("Bearer "),
  });
  ```

  `acceptSession` only runs once a request has a session. An API key or bearer token on its own gives one only through a plugin that turns it into a session (better-auth's `bearer`, or API keys with sessions enabled); without such a plugin that request is unauthenticated and answered 401 before `acceptSession` runs, so a rule like the one above applies when the header arrives next to a session cookie or through such a plugin.

  A guard of your own that runs before better-auth's handler (one that refuses impersonated sessions app-wide, say) answers support's requests first, so classify support's paths in it. The reads are `GET`, under your better-auth base path (`/api/auth` by default): `/support/my-tickets`, `/support/ticket`, `/support/attachment`, `/support/agent/tickets`, `/support/agent/ticket`, `/support/agent/tags`, `/support/agent/canned` and `/support/agent/attachment`. Every other support endpoint is `POST`. `supportPathMethods` from `@byo-oss/support/client` has the same map for code.

- **What customers get back.** One serializer: ticket `id, number, subject, status, priority, channel, organizationId, visibility, rating, createdAt, updatedAt, lastMessageAt, solvedAt, unread, isRequester`; `isRequester` is false for an organization teammate viewing a shared ticket (the widget hides solve, reopen, rate and share for them; the server refuses those with 403); messages of kind `reply`, plus `event` rows of type `status` and `merged`. Never `replyToken`, `assigneeId`, `agentSeenAt`, `mentions`, notes, other events, `verified`, `emailMessageId` or internal attachments. Agents appear by `{ name, image }` only.
- **Statuses.** A new ticket is `open`. An agent reply sets `pending` unless the request sets a `status`. A customer reply on `pending` or `solved` reopens it. The requester can solve (from `open` or `pending`) and reopen (from `solved`). Agents can set any status. The sweep closes `solved` tickets after `autoCloseAfter`. A `closed` ticket takes no replies (`TICKET_CLOSED`): mail to it opens a new ticket with a `followup_of` event.
- **Merging.** An agent can merge a ticket into another with the same requester and the same organization (`MERGE_NOT_ALLOWED` otherwise). Messages, tags, attachments and deliveries move to the target; the stricter `visibility` (`private`) and `verified` (`false`) win, and the target keeps the later `lastMessageAt` of the two; the source is closed with `mergedIntoId`. Every endpoint that takes a ticket id follows `mergedIntoId`, with the access rule re-applied to the target, except `mergeSupportTickets` and `deleteSupportTickets`, which act on the ids given.

## Components

### Widget: popover or inline

`<SupportWidget />` is a popover by default: a launcher button with the unread count, and a panel that opens below it, 360 px wide at most, aligned to the launcher's right edge so it extends to the left. Put it at the right end of your header; near the left edge of the screen the panel would run off it. Escape or a click outside closes it.

`variant="inline"` renders the panel in place instead, at the full width of its container, with no launcher, and it never closes. Use it for a page of its own: "My tickets", or the page your email links open.

- `ticketId` opens that ticket's thread (a popover starts open unless `defaultOpen` or `open` says otherwise). A new value opens that ticket; `null` or `undefined` after a ticket goes back to the list. Back goes to the list.
- `onTicketChange(id | null)` is called when the user opens a ticket (a row, or the one they just created) with its id, and with `null` when they go Back to the list or the new-ticket form. Sync your URL with it, so Back on an inline page doesn't leave the address on the old ticket. Changes that come from the `ticketId` prop never call it. If the user leaves the new-ticket form (Back) before the ticket is created, the widget stays where they went and doesn't report it; the ticket shows up in the list.
- `defaultOpen` sets whether the popover starts open (default: open when `ticketId` is set).
- `open` and `onOpenChange` control the popover. The launcher, Escape and a click outside call `onOpenChange`, and the panel follows `open`. When your app sets `open` to `true` (not the launcher) while `ticketId` is set, the panel shows that ticket's thread. That is how the same link opens the same ticket again after the user closed the panel: set `open` back to `true`. The launcher reopens wherever the user left off; if your app declines a launcher click (keeps `open` false), its own later `open` still shows `ticketId`'s thread. Set `open` from `onOpenChange` in the same event: an `open` that turns `true` in a later render (after an `await`, in a transition, through a router navigation) counts as your app opening the panel and shows `ticketId`'s thread.

```tsx
const [open, setOpen] = useState(Boolean(ticketId));
<SupportWidget client={authClient} ticketId={ticketId} open={open} onOpenChange={setOpen} />
```

### Deep links

**Customers.** Email links (`ticketPath(id)`) and in-app notifications should open a page with the inline widget, which works at any width and doesn't close on the first click. Pass `onTicketChange` so the URL follows the widget:

```tsx
// /help?ticket=<id>, or whatever ticketPath returns
<SupportWidget
  client={authClient}
  variant="inline"
  ticketId={ticket ?? null}
  onTicketChange={(next) => router.push(next ? `/help?ticket=${next}` : "/help")}
  onNavigate={(href) => router.push(href)}
/>
```

`onTicketChange(null)` (Back to the list) needs an address too, so pick the list route together with `ticketPath`: the list at `/help` with `` ticketPath: (id) => `/help?ticket=${id}` `` as above, or one route with an optional id (`/help/{-$id}` in TanStack Router; in Next.js a layout, as for the inbox below) with `` ticketPath: (id) => `/help/${id}` ``.

Keep the page and the ticket on one route: a query parameter as above, an optional path parameter, or a layout route that renders the widget for both paths. Two sibling routes (`/help` and `/help/:id`, each rendering its own widget) remount the component every time the user opens a ticket or goes Back: it loads the list again from the first page and loses its scroll position and any pages loaded with "Load more".

**Staff.** `SupportInbox` takes `ticketId` (opens that ticket; `null` or `undefined` closes the thread) and `onTicketChange(id | null)`, called when the user opens a ticket, goes Back, follows a merge to its target or deletes the open ticket. Map both to a route such as `/staff/support/:id`, so notification links open the ticket and the URL follows the inbox. Changes that come from the `ticketId` prop never call `onTicketChange`, so the round trip doesn't loop. A merge or delete that settles after the agent opened another ticket leaves that ticket open and reports nothing, and nothing is reported after the inbox unmounts.

Render the inbox once, for both `/staff/support` and `/staff/support/:id`: from one route with an optional `:id`, or from a layout route whose child only declares the param. Don't render it from two sibling routes. Moving between siblings unmounts one inbox and mounts another, which loses the search, the filters and the checked rows every time the user opens or closes a ticket. For example, a TanStack Router layout route `/staff/support` with a child `/staff/support/$id` that has no component of its own:

```tsx
// routes/staff.support.tsx: renders for /staff/support and /staff/support/<id>
function StaffSupport() {
  const navigate = useNavigate();
  const { id } = useParams({ strict: false }); // set by the child route
  const { agents } = Route.useLoaderData();
  return (
    <SupportInbox
      client={authClient}
      agents={agents}
      ticketId={id ?? null}
      onTicketChange={(next) => navigate({ href: next ? `/staff/support/${next}` : "/staff/support" })}
      onNavigate={(href) => navigate({ href })}
    />
  );
}
```

With Next.js, render the inbox from `app/staff/support/layout.tsx` (a layout stays mounted as its child pages change), read the id with `useParams()`, give `app/staff/support/page.tsx` and `app/staff/support/[id]/page.tsx` nothing to render, and push the same paths with `router.push`.

### Staff list (`agents`)

`agents` fills the inbox's assignee and @mention pickers. Keep only the staff organization's members whose role grants `support: ["read"]`: that is the check `isAgent` makes, so anyone else would show up in the pickers and fail with `NOT_AN_AGENT` when picked. Derive it from your roles' permissions, never from role names. A member can hold several roles (`"admin,billing"`).

On the server, from the staff organization's members:

```ts
import { roles } from "./access"; // step 2

const canRead = (role: string) =>
  role.split(",").some((name) => roles[name.trim() as keyof typeof roles]?.authorize({ support: ["read"] }).success);

const organization = await auth.api.getFullOrganization({ headers, query: { organizationId: staffOrganizationId } });
const agents = (organization?.members ?? [])
  .filter((member) => canRead(member.role))
  .map((member) => ({ id: member.userId, name: member.user.name, image: member.user.image }));
```

In the browser (a single-page app with no server code of its own), from a staff member's session, with the same `canRead`, or better-auth's `authClient.organization.checkRolePermission({ role, permissions: { support: ["read"] } })` for each of the member's roles when `organizationClient` was given your `ac` and `roles`:

```ts
const { data } = await authClient.organization.listMembers({
  query: { organizationId: staffOrganizationId, limit: 100 },
});
const agents = (data?.members ?? [])
  .filter((member) => canRead(member.role))
  .map((member) => ({ id: member.userId, name: member.user.name, image: member.user.image }));
```

Both read one page of members: `getFullOrganization` returns up to the organization plugin's `membershipLimit` (100 by default), and `listMembers` returns `limit` members (the organization plugin's `membershipLimit`, 100 by default) and a `total`. With a larger staff organization, page through `listMembers` with `offset`.

### Inbox layout

Give `SupportInbox` a height: put it in a flex column with `className="min-h-0 flex-1"`, or give its parent a fixed height. With a height, the queue, the thread and the details panel each scroll on their own and the composer stays at the bottom of the thread. Without one, the inbox grows with its content and the page scrolls instead, taking the ticket's header and the composer out of view on a long thread. It is never shorter than 28rem.

From `md` up the queue and the thread sit side by side, and from `lg` up the details panel (requester, status, priority, assignee, tags, merge, delete) is a third column. Below that, a Details button shows it. On a phone the queue and the thread take turns.

The composer keeps each ticket's unsent text and its Reply or Internal note choice while the agent opens other tickets, for as long as the inbox is mounted. Ctrl+Enter (Cmd+Enter) sends. **Send and solve** replies and sets the ticket to solved in one request; it is offered on open and pending tickets, for replies, not notes. With attachments on, files can also be dropped on the composer or pasted into it, and png, jpeg, gif and webp attachments up to 5 MB show a preview in the thread (in the widget too).

The widget names statuses in the customer's words (`customerStatus`: "With our team", "Awaiting your reply", "Solved", "Closed"). A status you renamed in `status` keeps your name there until you set `customerStatus`. Every relative time shows the full date on hover, from `absoluteTime`.

### Polling

The components poll; there are no websockets. While the tab is hidden, nothing polls.

- **Widget, closed popover:** the ticket list every `badgePollInterval` (60 s by default), for the launcher's unread count. That is one request a minute per signed-in tab on every page that shows the launcher.
- **Widget, open or inline:** the ticket list and the open thread every `pollInterval` (15 s by default). Opening the popover refreshes at once.
- **Inbox:** the queue and the open ticket every `pollInterval` (15 s by default).

`0` turns either interval off. The two widget intervals are independent: `pollInterval={0}` leaves the badge poll on.

### Wording, sizes and fields

**Wording.** The default copy never says "agent" or "inbox", which apps often use for their own AI agents and inbox: the staff view's heading is "Support queue", a reply from staff without a name shows as "Support", and the message of `NOT_AN_AGENT` (which your app may show) says "That user is not on the support team". The API keeps "agent" as the name of the staff role: `SupportInbox` and its `agents` prop, the `/support/agent/*` endpoints, `isAgent`, `NOT_AN_AGENT`, `authorType: "agent"` and the `support.agent.*` events. Rename anything on screen with `labels`.

**Sizes.** On a coarse pointer (a touch screen), every button, field, ticket row and checkbox label is at least 44 px tall, and the × buttons are 44 px wide as well. With a mouse or trackpad they keep their compact size (about 32 px). This uses Tailwind's `pointer-coarse:` variant, which needs Tailwind 4.1 or newer; on 4.0 the controls stay compact everywhere. Fields use 16 px text below the `md` breakpoint (`text-base md:text-sm`), so iOS doesn't zoom into a focused field. Your `@source` line already covers these classes.

**Fields.** `fieldClassName`, on both components, is added to every text input, select and textarea (not to checkboxes, radios or the file input). Like the other class props it appends with no merging; see [Tailwind](#tailwind).

## Email replies

Add a `Mailer` and `email` and every public agent reply is queued for the requester. Notes are never mailed.

```
npm install @wraps.dev/email
```

```ts
import { support } from "@byo-oss/support";
import { wrapsMailer } from "@byo-oss/support/wraps";

support({
  staffOrganizationId,
  mailer: wrapsMailer({ from: "Acme Support <support@acme.com>" }),
  email: {
    from: "Acme Support <support@acme.com>", // the same address the mailer sends from
    replyDomain: "reply.acme.com",
    appUrl: "https://app.acme.com",
  },
});
```

`wrapsMailer` is re-exported from `@byo-oss/mailer/wraps`; it sends through your own AWS SES account, and the sender must be verified there. Any object with `send(message)` is a `Mailer`: resolve `{ id, messageId? }`, throw to retry, throw `PermanentMailError` (from `@byo-oss/mailer`) for a send that can never succeed. Run `testMailer` from `@byo-oss/mailer/testing` against your own. `@byo-oss/mailer` also has `sesMailer` (`@byo-oss/mailer/ses`, for an SES v2 client you already have) and `emailSdkMailer` (`@byo-oss/mailer/email-sdk`, for the providers behind email-sdk); to import those subpaths, add `@byo-oss/mailer` as a direct dependency (pnpm doesn't expose a dependency's dependencies).

What gets sent:

- **Subject** `[#123] <subject>`, **Reply-To** `support+<token>@<replyDomain>`, a plain text body and an escaped HTML copy, and a link to the ticket (`appUrl` plus `ticketPath(id)`). Route that path to a page that renders `<SupportWidget variant="inline" ticketId={id} />` (see [Deep links](#deep-links)): with `ticketId` the widget shows that ticket's thread, Back returns to the list, and a ticket the signed-in user can't read shows the thread's error state. For example `` ticketPath: (id) => `/help?ticket=${id}` `` with the help page reading `ticket` from the query. Set `ticketPath` whenever the default `/support/<id>` could collide with your routes, for example a top-level `/:org` segment where `support` would be read as an organization slug. Attachments go as that link, not as files.
- **The address** is resolved when the mail is sent: the account's email if verified (or any, with `requireVerifiedEmail: false`), else the account-less requester's `requesterEmail`. No address: the delivery is `skipped`.
- **Delay.** A reply is due `replyDelay` after it was written (2 minutes by default) and skipped if the requester has seen the ticket since. With `replyDelay: 0` and better-auth's `advanced.backgroundTasks.handler` set, it sends inline; otherwise the sweep sends it.
- **Threading** uses the reply token in Reply-To. `In-Reply-To` and `References` are added when a stored Message-ID is known: inbound mail always stores one, and `wrapsMailer` or `sesMailer` sending through SES in us-east-1 reports the sent Message-ID, so your replies are threaded too. In other regions, or with a custom endpoint, they report none and replies thread by the token alone. `References` keeps the newest ids up to 900 characters (SES refuses a longer header) and leaves out ids that aren't printable ASCII.

**Run the sweep on a schedule.** A plugin can't run jobs, so delayed mail, retries, auto-closing solved tickets and pruning stale uploads happen when you call `processSupportDeliveries` from your scheduler, every minute or so. Without it, delayed replies never go out and solved tickets never close (the sweep works without a `mailer` too):

```ts
// app/api/cron/support/route.ts
export async function GET() {
  const result = await auth.api.processSupportDeliveries({});
  return Response.json(result); // { sent, skipped, retrying, failed, hasMore, closed, pruned }
}
```

Call it again while `hasMore` is true. If you use several BYO plugins, one route can sweep them all with `@byo-oss/core`:

```ts
import { sweepAll } from "@byo-oss/core";

export async function GET() {
  return Response.json(await sweepAll(auth, { budgetMs: 20_000 }));
}
```

Protect the route the way your scheduler expects (a shared secret header, or a platform cron that isn't publicly reachable). `processSupportDeliveries` itself is server-only: it is never an HTTP route.

Each delivery is a row in `supportDelivery` with its status and the reason it was skipped or the last error.

## Inbound email

Customers, and people with no account, can email your support address. Mail to `support+<token>@<replyDomain>` continues that ticket; any other mail your relay posts to the endpoint opens a new one, so route your public support address (`support@acme.com`) to it as well as the reply domain. Add `inbound` (it needs `email`, for the reply domain and the loop guard):

```ts
import { rawRelay, support } from "@byo-oss/support";

support({
  // ...mailer and email as above
  inbound: { source: rawRelay({ secret: process.env.SUPPORT_INBOUND_SECRET! }) },
});
```

The endpoint is `POST <your auth base path>/support/inbound`, for example `https://app.acme.com/api/auth/support/inbound`. It takes no session: the **source** authenticates the relay and reads the raw RFC 822 bytes. Route all mail for `replyDomain`, plus-addresses included, and your public support address to it.

**`rawRelay({ secret, maxBytes? })`** works with any relay that POSTs the raw message (`Content-Type: message/rfc822`) with `Authorization: Bearer <secret>`: Postmark inbound, Mailgun routes, a Cloudflare Email Worker. The secret is compared in constant time (401 on a mismatch), a message over `maxBytes` (25 MiB by default) answers 413 and an empty body 400. The secret must not contain whitespace: the bearer token can't carry it, so `rawRelay` throws at boot rather than answer 401 to every message (trim a value read from a file). SES's spam and virus verdicts (below) apply only when the relay passes SES's headers through in the raw message; other relays don't add them.

**`wrapsInbound({ key, bucket, region, client?, maxBytes? })`** from `@byo-oss/support/wraps` takes Wraps inbound mail (SES to S3, announced by an EventBridge `email.received` event). Point an EventBridge API destination at the endpoint with the header `X-Wraps-Inbound-Key: <key>`. The source reads `rawS3Key` from the event (the whole event or just its `detail`) and fetches that object. The key must not start or end with whitespace (header values arrive trimmed, so it could never match): `wrapsInbound` throws at boot instead. It needs `@aws-sdk/client-s3` and a role that can read the bucket:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::YOUR_BUCKET/*" },
    { "Effect": "Allow", "Action": "s3:ListBucket", "Resource": "arn:aws:s3:::YOUR_BUCKET" }
  ]
}
```

Grant `s3:ListBucket` as well as `s3:GetObject`. Without `ListBucket`, S3 reports a missing object as `AccessDenied` instead of `NoSuchKey`, so a message that is gone looks like a failure and the relay retries it forever. With it, a missing object answers 404 and is not retried; any other S3 error answers 502 and is.

One Wraps inbound stack emits an `email.received` event for every domain it receives mail for, so filter the EventBridge rule behind the API destination on `detail.receivingDomain` (your `replyDomain`). Without the filter, mail for every domain the stack receives reaches support and opens tickets.

```json
{
  "source": ["wraps.inbound"],
  "detail-type": ["email.received"],
  "detail": { "receivingDomain": ["support.acme.com"] }
}
```

Matching is exact and case-sensitive, and Wraps takes `receivingDomain` from the message's first `To` address as written, so mail that reaches support only by Cc or Bcc, or with another address first in `To`, carries another domain (or none) and the rule skips it. Use `[{ "equals-ignore-case": "support.acme.com" }]` to match any case, and add another domain only if it receives nothing but support mail: Wraps receives every address on a domain and support doesn't check the recipient, so on a shared domain (`sales@`, `billing@`) every unthreaded message would open a ticket. Keep the public support address on a dedicated subdomain instead.

What the endpoint does with a message:

- **Answers 202** for every message it took, dropped and duplicate ones included, so the relay stops retrying. Each drop is logged once through better-auth's logger, at `warn` (a duplicate, a relay's retry, at `info`), with the reason and the sender's domain only: `[@byo-oss/support] dropped an inbound email: auto_reply (sender domain: customer.com)`. better-auth logs `warn` by default; set its `logger: { level: "info" }` to see duplicates too. A source's `{ reject: status }` is answered with that status, and a source that throws is answered 502 (retry). Without `inbound` the endpoint answers 404 `INBOUND_NOT_CONFIGURED`.
- **Drops** mail SES found a virus in (below), mail from your own `from` address or any address at `replyDomain` (loop guard), auto-replies (`Auto-Submitted` other than `no`, `X-Auto-Response-Suppress`, `Precedence: bulk|junk|auto_reply`), bounces (empty return path, `MAILER-DAEMON`, `postmaster`, delivery reports), a Message-ID it already stored, mail with no sender, unparseable mail, and anything past the caps below.
- **Verifies** the sender. A message is `verified` when it carries a passing DKIM signature aligned with the From domain, whether or not the domain publishes DMARC. The relay's own authentication headers (`Authentication-Results` and the like) are ignored. The check reads DNS, so it needs Node's `dns` module: it does not run on edge runtimes.
- **Spam and virus verdicts.** SES scans the mail it receives and adds `X-SES-Spam-Verdict` and `X-SES-Virus-Verdict` at the top of the message, above every header the sender wrote. Support reads them from the raw message, so the rule is the same for `wrapsInbound` and for a `rawRelay` fed from SES (Wraps' `spamVerdict` and `virusVerdict` event fields come from the same headers and aren't read). Virus `FAIL`: the message is dropped and support stores nothing of it, attachments included (with `wrapsInbound`, your Wraps bucket still holds the raw message and its parts). Spam `FAIL`: the message counts as unverified whatever its DKIM says, so it never appends to a ticket, never links to an account, counts toward `maxUnverifiedPerHour` and opens a new ticket only under `newTickets`. `GRAY`, `PROCESSING_FAILED` or no verdict change nothing. Only the first copy of each header is read, which is SES's, so a copy the sender wrote further down can't hide a `FAIL`. Without SES scanning (turned off in the receipt rule, or another relay) a copy present is the sender's own; since only `FAIL` acts, it can only make that sender's message stricter.
- **Caps.** `maxPerSenderPerHour` counts verified email replies from that sender; `maxUnverifiedPerHour` counts every unverified message, so forged mail never uses up a real customer's cap.
- **Threads** by the reply token in a `support+<token>@<replyDomain>` recipient, then by `In-Reply-To` and `References` matching a stored Message-ID. Never by subject. Merged tickets resolve to their target.
- **Appends** only verified mail from the requester (an account's verified email, or the stored `requesterEmail`), or, on an organization-shared ticket, from a member whose verified account has that address. Anything else opens a new private ticket with no organization, never linked to the thread.
- **Links to accounts** only verified mail from a verified account. Unverified mail from an account holder's address is stored as an account-less sender (`requesterEmail`), so a forged `From:` can't put a ticket in someone's account. When a user later verifies that address, their verified tickets and messages are linked to them (`linkSupportRequester` does the same on demand).
- **Stores** the plain text part with the quoted reply stripped. The raw message is not stored. With `attachments`, parts are stored under the same limits; a part that is over the limit, of a disallowed type or fails to store is dropped, and an `attachment_dropped` event row records it.

Test your own source with `testSupportInboundSource` from `@byo-oss/support/testing`. To test threading end to end without real DNS, sign test mail with a key of your own (`dkimSign` from `mailauth`, say) and serve its public key through `inbound.resolver`:

```ts
const resolver: DkimResolver = async (name, rrtype) => {
  if (rrtype === "TXT" && name === "test._domainkey.customer.test") return [[`v=DKIM1; k=rsa; p=${publicKey}`]];
  throw Object.assign(new Error(`ENOTFOUND ${name}`), { code: "ENOTFOUND" });
};
support({ /* ... */ inbound: { source: rawRelay({ secret }), resolver } });
```

## Attachments

Add `attachments` and customers and agents can attach files to replies, agents can attach files to internal notes, and inbound mail keeps its attachment parts.

```
npm install @aws-sdk/client-s3
```

```ts
import { s3Storage } from "@byo-oss/support/s3";

support({
  attachments: {
    storage: s3Storage({ bucket: "acme-support", region: "us-east-1" }),
    // maxBytes: 10 * 1024 * 1024,
    // allowedTypes: ["image/png", "application/pdf"],
  },
});
```

`s3Storage({ bucket, region, endpoint?, forcePathStyle?, credentials?, client? })` works with S3 and S3-compatible stores (R2, MinIO: set `endpoint`, and `forcePathStyle` for MinIO). The role needs `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` and `s3:ListBucket` on the bucket. Blobs are stored under `support/<organizationId or "_">/<attachmentId>`.

`SupportStorage` is `{ put, get, delete, deletePrefix }`: every method throws to fail the request, `get` resolves `null` for a missing key, and `delete` of a missing key resolves. Run `testSupportStorage` from `@byo-oss/support/testing` against your own; `memoryStorage()` from the same subpath is a store for tests.

- **Uploading.** `POST /support/upload?ticketId=…&filename=…` with the file as the raw request body and its type as `Content-Type` (agents: `/support/agent/upload`, plus `internal=true` for a note). A missing or over-limit `Content-Length` answers 413 `ATTACHMENT_TOO_LARGE`, a type not in `allowedTypes` answers 415 `ATTACHMENT_TYPE_NOT_ALLOWED`, and the body is counted as it is read, so a header that lies can't store more than it claimed. The upload comes back unattached; pass its id in `attachmentIds` (up to 10) on the next reply or note.
- **Binding.** Every id must belong to the same ticket, be uploaded by the caller, be unattached, and match the audience (an `internal` upload only on a note); otherwise `ATTACHMENT_NOT_USABLE`. The sweep deletes uploads still unattached after 24 hours.
- **Reading.** Attached files follow the ticket's read rule, and customers never get internal ones. An unattached file is readable only by its uploader and by agents. Files are served with `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox` and `Cache-Control: private, no-store`, and only png, jpeg, gif, webp and pdf keep their type; everything else is `application/octet-stream`.
- **Default allowed types:** `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `application/pdf`, `text/plain`, `text/csv`, `application/zip`.

## Lifecycle

Support cleans up after the organization plugin's own endpoints, with no wiring. After `/organization/delete` it deletes that organization's tickets; after `/organization/remove-member` and `/organization/leave` it unassigns the member's tickets if they left the staff organization (in a customer organization nothing changes: teammate access is checked live, and requesters keep their own tickets). A hook acts only when the endpoint succeeded, takes ids only from the response, and logs errors without failing it.

`organizationCleanup: false` turns the row cleanup off, for apps that keep history. On memory and MongoDB that keeps the organization's tickets; on SQL the `organizationId` foreign key still cascades the ticket rows away. The blobs under `support/<orgId>/` are always removed when an organization is deleted, because cascaded tickets leave no row that points at them.

For deletes made any other way (a script, an admin tool, a direct database write), call the functions yourself. They run inside a better-auth transaction (`runWithTransaction`) when called in one, and are safe to run again:

```ts
import {
  deleteMemberData,
  deleteOrganizationData,
  deleteSupportRequesterData,
  linkSupportRequester,
} from "@byo-oss/support";

await deleteOrganizationData(auth, organizationId); // → { tickets }; also deletes the support/<orgId>/ blobs
await deleteMemberData(auth, { userId, organizationId }); // → { unassigned }
await deleteSupportRequesterData(auth, { email }); // → { tickets, messages }
await linkSupportRequester(auth, userId); // → { tickets, messages }
```

- **A user is deleted.** Foreign keys null `userId` (requester, author, uploader) and `assigneeId` on SQL; a `user.delete` hook does the same on adapters without them (memory, MongoDB) and clears any stored copy of their email (a user deleted outside better-auth keeps those email copies until `deleteSupportRequesterData` runs for the address). On every adapter the hook also removes their id from message `mentions` and sets it to null in `assignee` event rows (`from`/`to`), which no foreign key reaches; it pages through every agent-authored message to do so, so a user delete costs time in proportion to that table. A user deleted outside better-auth keeps their id in mentions and assignee events; no exported function removes it.
- **An account-less person** (someone who only emailed) asks to be erased: `deleteSupportRequesterData` deletes their tickets with all their messages, tags and attachments, and anonymizes their messages on other tickets.
- **An organization is removed outside the organization plugin** and leaves its blobs behind until `deleteOrganizationData` runs.
- **With `@byo-oss/core`** the fan-out reaches support through its `byo` hooks, so one call cleans every BYO plugin:

  ```ts
  import { deleteMemberData, deleteOrganizationData } from "@byo-oss/core";

  organization({
    organizationHooks: {
      afterDeleteOrganization: async ({ organization }) => {
        await deleteOrganizationData(auth, organization.id);
      },
      afterRemoveMember: async ({ member }) => {
        await deleteMemberData(auth, { userId: member.userId, organizationId: member.organizationId });
      },
    },
  });
  ```

  Running this next to support's automatic hooks is safe. Add it for the other plugins' sake, and for deletes the endpoint hooks don't see.

## Events to notifications

Support emits an event after every write that matters, through `onEvent`. Events are in-process and best-effort: a handler that throws is logged and never fails the request, and nothing is stored or retried.

Events fire after the write commits. Endpoint writes don't join a caller's transaction, so their events follow at once; `sweepAll` inside your `runWithTransaction` holds the sweep's `support.ticket.status_changed` events until it commits and drops them on rollback. Join with `runWithTransaction`, imported from `@better-auth/core/context` (`better-auth` doesn't export it). A plain `adapter.transaction(trx => …)` isn't joined at all, so the plugin's writes commit at once along with their events. Wrapping with `runWithAdapter(trx, …)` makes them join, but their events fire before the commit. Use `runWithTransaction`. On an adapter without transactions the events fire at once. If you call `runWithTransaction` yourself, pass `{ onAfterCommitHookError }` so a hook queued earlier in the same transaction that throws can't skip the events queued after it. `data` carries ids, statuses and kinds, never message bodies, and always the ticket's `visibility` (`"private"` or `"organization"`) besides the fields below.

| Event | `userId` | `data` (plus `visibility`) |
|---|---|---|
| `support.ticket.created` | requester | `{ ticketId, number, channel }` |
| `support.ticket.status_changed` | requester | `{ ticketId, from, to }` |
| `support.ticket.assigned` | the new assignee (absent when unassigned) | `{ ticketId, from, to }` |
| `support.ticket.merged` | requester | `{ ticketId, sourceId, targetId }` (subject is the target) |
| `support.customer.replied` | requester | `{ ticketId, messageId, channel }` |
| `support.agent.replied` | requester | `{ ticketId, messageId, status }` |
| `support.note.added` | none | `{ ticketId, messageId }` |
| `support.agent.mentioned` | the mentioned agent (one event each) | `{ ticketId, messageId, kind }` |

Every event also has `type`, `occurredAt`, `actorId`, `organizationId` (the ticket's, when it has one) and `subject: { type: "supportTicket", id }`. The `userId` of an account-less requester is absent. A private ticket's events still carry its `organizationId`: consumers that fan out by organization must skip `visibility: "private"`.

Wire them to [`@byo-oss/notifications`](https://github.com/byo-oss/notifications) with `createEventBus` from `@byo-oss/core`. Staff recipients are the staff organization's members whose role grants `support: ["read"]`, read when the event is sent; derive them from your roles' permissions, never from a list of role names:

```ts
import { createEventBus } from "@byo-oss/core";
import { roles } from "./access"; // step 2

const staffOrganizationId = process.env.SUPPORT_STAFF_ORGANIZATION_ID!;

// staff-organization members whose role grants support:read, except the actor
async function supportStaff(exceptUserId?: string | null): Promise<string[]> {
  const ctx = await auth.$context;
  const members = await ctx.adapter.findMany<{ userId: string; role: string }>({
    model: "member",
    where: [{ field: "organizationId", value: staffOrganizationId }],
    limit: 1000,
  });
  const canRead = (role: string) =>
    role
      .split(",") // a member can hold several roles
      .some((name) => roles[name.trim() as keyof typeof roles]?.authorize({ support: ["read"] }).success);
  return members.filter((m) => canRead(m.role) && m.userId !== exceptUserId).map((m) => m.userId);
}

const onEvent = createEventBus([
  async (event): Promise<void> => {
    const ticketId = event.subject.id;
    switch (event.type) {
      // staff: everyone who can read the queue, except whoever caused the event
      case "support.ticket.created":
      case "support.customer.replied": {
        const title = event.type === "support.ticket.created" ? "New support ticket" : "Customer replied";
        for (const userId of await supportStaff(event.actorId)) {
          // the /staff/support layout renders <SupportInbox ticketId={id} /> for /staff/support/:id (see Deep links)
          await auth.api.notify({
            body: { userId, type: event.type, title, href: `/staff/support/${ticketId}` },
          });
        }
        break;
      }
      // the one agent it is about
      case "support.agent.mentioned":
      case "support.ticket.assigned":
        if (event.userId) {
          await auth.api.notify({
            body: {
              userId: event.userId,
              type: event.type,
              title: event.type === "support.agent.mentioned" ? "You were mentioned" : "A ticket was assigned to you",
              href: `/staff/support/${ticketId}`,
            },
          });
        }
        break;
      // the requester, in-app
      case "support.agent.replied":
        if (event.userId) {
          await auth.api.notify({
            // the help page renders <SupportWidget variant="inline" ticketId={ticket} />
            body: { userId: event.userId, type: event.type, title: "New reply to your ticket", href: `/help?ticket=${ticketId}` },
          });
        }
        break;
    }
  },
]);

export const auth = betterAuth({
  plugins: [organization({ ac, roles }), support({ staffOrganizationId, onEvent }), inbox()],
});
```

If you use dynamic access control, check the organization's stored roles the same way. If your app already has a notification layer (a catalog of notification types, preferences, digests), route support's events through it instead of calling `notify` directly; the recipient rules below stay the same.

Which events go where:

- **Staff:** `support.ticket.created`, `support.customer.replied`, `support.ticket.assigned` (to the new assignee) and `support.agent.mentioned` (to the mentioned agent). Notify only members of the staff organization whose role grants `support` actions; read members at send time, so a removed agent stops receiving them.
- **The requester:** `support.agent.replied`, and `support.ticket.status_changed` if you want to tell them a ticket was solved. Route by `event.userId`.
- **Never to customers: `support.note.added`.** An internal note has its own event type so that forwarding `support.agent.replied` to customers can't leak one. It carries no `userId`; keep it that way in your handler, and send it to staff or nowhere.
- With a `mailer`, the requester also gets the reply by email. Use the in-app notification as the nudge and leave the email to support.

## API

All of these are better-auth endpoints: call them through `auth.api` on the server (with `{ headers, body }` or `{ headers, query }`) or through `authClient.support.*` in the browser. Every endpoint is one of the kinds in the [BYO conventions](https://github.com/byo-oss/conventions/blob/main/SPEC.md): **own rows** needs a session and works only on the caller's own tickets (and those shared with an organization they belong to); **permission-gated** needs a session and a `support` permission in the staff organization; **server-only** is never an HTTP route; **credential-free** takes no session and is verified by its inbound source.

| `auth.api` key | Method and path | Kind | Input | Returns |
|---|---|---|---|---|
| `createSupportTicket` | POST `/support/create-ticket` | own rows | body `subject`, `body`, `organizationId?`, `visibility?` (`"private"` default, or `"organization"`) | `{ ticket }` |
| `listMySupportTickets` | GET `/support/my-tickets` | own rows (and org-shared, where a member) | query `status?`, `organizationId?`, `q?`, `cursor?` | `{ tickets, nextCursor, features: { attachments } }` |
| `getSupportTicket` | GET `/support/ticket` | own rows | query `id` | `{ ticket, messages, attachments }` (customer-visible only) |
| `replyToSupportTicket` | POST `/support/reply` | own rows | body `ticketId`, `body`, `attachmentIds?` | `{ message }` |
| `updateMySupportTicket` | POST `/support/update-mine` | own rows (requester only) | body `id`, `status?` (`"solved"` or `"open"`), `visibility?`, `rating?` (`"good"` or `"bad"`) | `{ ticket }` |
| `markSupportTicketSeen` | POST `/support/mark-seen` | own rows (requester only) | body `id` | `{ ok: true }` |
| `uploadSupportAttachment` | POST `/support/upload` | own rows | query `ticketId`, `filename`; raw body; `Content-Type` is the file's type | `{ attachment }` (unattached) |
| `getSupportAttachment` | GET `/support/attachment` | own rows | query `id` | the file |
| `listSupportTickets` | GET `/support/agent/tickets` | permission-gated `support:read` | query `status?`, `assignee?` (a user id, `"me"` or `"none"`), `tag?`, `organizationId?`, `q?`, `cursor?` | `{ tickets, nextCursor, counts, features: { attachments, merge } }` |
| `getSupportTicketAsAgent` | GET `/support/agent/ticket` | permission-gated `support:read` | query `id` | `{ ticket, messages, attachments }` (every message, notes and events included) |
| `replyAsSupportAgent` | POST `/support/agent/reply` | permission-gated `support:reply` | body `ticketId`, `body`, `internal?` (a note), `status?`, `mentions?` (agent user ids, up to 20), `attachmentIds?` | `{ message }` |
| `updateSupportTickets` | POST `/support/agent/update` | permission-gated `support:update` | body `ids` (1 to 100), `status?`, `priority?` (or `null`), `assigneeId?` (or `null`), `addTags?`, `removeTags?` | `{ updated }`: the tickets matched, after merge-follow and dedupe, including any the update left unchanged |
| `mergeSupportTickets` | POST `/support/agent/merge` | permission-gated `support:update` | body `sourceId`, `targetId` | `{ ticket }` (the target) |
| `deleteSupportTickets` | POST `/support/agent/delete` | permission-gated `support:delete` | body `ids` (1 to 100) | `{ deleted }` |
| `markSupportTicketSeenAsAgent` | POST `/support/agent/mark-seen` | permission-gated `support:read` | body `id` | `{ ok: true }` |
| `listSupportTags` | GET `/support/agent/tags` | permission-gated `support:read` | none | `string[]` (sorted, deduped) |
| `listSupportCannedReplies` | GET `/support/agent/canned` | permission-gated `support:read` | query `q?` (title contains) | canned replies, by title, up to 200 |
| `saveSupportCannedReply` | POST `/support/agent/canned/save` | permission-gated `support:manage` | body `id?` (omit to create), `title`, `body` | `{ cannedReply }` |
| `deleteSupportCannedReply` | POST `/support/agent/canned/delete` | permission-gated `support:manage` | body `id` | `{ ok: true }` |
| `uploadSupportAttachmentAsAgent` | POST `/support/agent/upload` | permission-gated `support:reply` | query `ticketId`, `filename`, `internal?` (`"true"`/`"false"`); raw body | `{ attachment }` (unattached) |
| `getSupportAttachmentAsAgent` | GET `/support/agent/attachment` | permission-gated `support:read` | query `id` | the file |
| `processSupportDeliveries` | none | server-only | none | `{ sent, skipped, retrying, failed, hasMore, closed, pruned }` |
| `receiveSupportEmail` | POST `/support/inbound` | credential-free, verified by its inbound source | the raw request | 202 `{ ok: true }`, or the source's status |

Lists are newest `lastMessageAt` first, `pageSize` at a time, and `nextCursor` is opaque: pass it back as `cursor` (an invalid one answers `INVALID_CURSOR`). `counts` on the agent list is queue-wide and ignores the filters: `{ open, pending, unassigned, mine }`. An unauthenticated call answers 401.

**`features`** tells a client what is switched on. `listMySupportTickets` returns `features.attachments`; `listSupportTickets` returns `features.attachments` and `features.merge`. The components use it to hide the attach and merge controls.

**Input limits:** `subject` 1 to 200 characters (trimmed), `body` 1 to 50,000, canned `title` 200 and `body` 50,000, `ids` up to 100, `attachmentIds` up to 10, `mentions` up to 20, `q` up to 200, `cursor` up to 10,000, a tag 1 to 50 characters of lowercase letters, digits, `-` and `_`, a stored filename up to 200.

Server-only functions (not endpoints), for your own scripts and hooks:

| Function | Description |
|---|---|
| `exportSupportData(auth, { organizationId?, cursor?, limit? })` | One page of everything, as plain JSON → `{ tickets, cannedReplies, cursor }`. See [Export](#export) |
| `deleteOrganizationData(auth, organizationId)` | Deletes an organization's tickets and its blobs → `{ tickets }` |
| `deleteMemberData(auth, { userId, organizationId })` | Unassigns a staff member's tickets → `{ unassigned }` |
| `deleteSupportRequesterData(auth, { email })` | Erases an account-less person → `{ tickets, messages }` |
| `linkSupportRequester(auth, userId)` | Links a verified user's account-less history → `{ tickets, messages }` |

Also exported from the root: `supportStatements`, `supportRoles`, `SUPPORT_ERROR_CODES`, `SUPPORT_EVENT_TYPES`, `rawRelay`, and the types `SupportOptions`, `SupportEvent`, `Mailer`, `SupportInboundSource`, `SupportStorage`, `DkimResolver` and the rest of the option and response types. From `@byo-oss/support/react`: `SupportWidget`, `SupportInbox`, and the headless hooks `useSupportTickets`, `useSupportTicket`, `useSupportQueue`, `useSupportAgentTicket`, `useSupportCannedReplies` and `useSupportUpload`, with `defaultLabels`, `defaultWidgetLabels` and `defaultInboxLabels`.

### Error codes

`SUPPORT_ERROR_CODES` is exported and set as the plugin's `$ERROR_CODES`. Responses are `{ code, message }`.

| Code | Status | When |
|---|---|---|
| `ORGANIZATION_PLUGIN_REQUIRED` | thrown at boot | `organization()` is not in `plugins` |
| `TICKET_NOT_FOUND` | 404 | The ticket doesn't exist, or this customer can't see it (no existence leak) |
| `NOT_ALLOWED` | 403 | An agent action `authorize` denied; a teammate on a requester-only action; `visibility: "organization"` on a ticket with no organization |
| `SESSION_NOT_ACCEPTED` | 403 | `acceptSession` returned `false` (by default, an impersonated session) |
| `NOT_A_MEMBER` | 403 | Creating or sharing with an organization the caller isn't a member of |
| `TICKET_CLOSED` | 400 | A reply on a closed ticket, or a requester status change on one |
| `INVALID_STATUS_TRANSITION` | 400 | A requester status change the rules refuse |
| `INBOUND_NOT_CONFIGURED` | 404 | `/support/inbound` without `inbound` |
| `MERGE_NOT_ALLOWED` | 400 | A different requester or organization, the same ticket, or a source or target already merged |
| `STORAGE_NOT_CONFIGURED` | 400 | An upload or download, or `attachmentIds`, without `attachments` |
| `ATTACHMENT_TOO_LARGE` | 413 | Missing or over-limit `Content-Length`, or more bytes than declared |
| `ATTACHMENT_TYPE_NOT_ALLOWED` | 415 | A content type not in `allowedTypes` |
| `ATTACHMENT_NOT_USABLE` | 400 | An id in `attachmentIds` failed the binding rules |
| `ATTACHMENT_NOT_FOUND` | 404 | The attachment or its blob is missing, or this caller can't read it |
| `NOT_AN_AGENT` | 400 | An assignee or a mention that fails `isAgent` |
| `INVALID_CURSOR` | 400 | A malformed cursor |
| `INVALID_TAG` | 400 | A tag that is empty, too long or has characters outside `a-z0-9_-` |
| `CANNED_REPLY_NOT_FOUND` | 404 | Saving a canned reply with an unknown `id` |

## Delivery guarantees

Outbound mail is **at-least-once**. A delivery is claimed atomically before it is sent, so overlapping sweeps don't double-send. A failed send retries with backoff (1 minute, doubling, up to an hour) and is marked `failed` after `maxAttempts` (5); a `PermanentMailError` fails it at once. A worker that dies mid-send has its delivery retried after `leaseMs` (5 minutes), so a crash after the provider accepted the mail but before the row was marked `sent` sends it twice, and so does a send that outlasts the lease. A stale delivery that has used up its attempts becomes `failed`.

Inbound mail is stored once per Message-ID: a relay's retry or a concurrent duplicate is answered 202 and writes nothing. Events are best-effort and in-process; nothing is retried.

## Schema

These tables are a public contract: a change that breaks reading existing rows is a major release. Rename tables or fields with the `schema` option. Nothing is added to better-auth's own tables. Emails are stored lowercased. The plugin declares indexes on the fields it filters by (`organizationId`, `userId`, `assigneeId`, `ticketId`, `tag`, `status`, `lastMessageAt`, `requesterEmail`, `authorEmail`, delivery `status` and `scheduledFor`, and the message and attachment `createdAt`). Don't query or write these tables from app code: go through `auth.api.*`, the hooks and the exported functions.

**`supportTicket`**

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Primary key |
| `number` | number, unique | The display number (`#123`), from `supportCounter` |
| `subject` | string | |
| `status` | string | `open`, `pending`, `solved` or `closed` |
| `priority` | string, optional | `low`, `normal`, `high` or `urgent` |
| `channel` | string | `web` or `email`: how it was opened |
| `userId` | string → `user.id`, set null, optional | The requester's account |
| `requesterEmail` | string, optional | An account-less requester's address. Never copied from an account. Cleared when the ticket is linked |
| `requesterName` | string, optional | Same rule as `requesterEmail` |
| `organizationId` | string → `organization.id`, cascade, optional | The customer organization. Null for tickets opened by mail |
| `visibility` | string | `private`, or `organization` (visible to that organization's current members) |
| `assigneeId` | string → `user.id`, set null, optional | The assigned agent |
| `rating` | string, optional | `good` or `bad`, set by the requester |
| `verified` | boolean | `true` for web tickets; for email tickets, the creating message's DKIM result. A later append never flips it to `true`. Shown to agents only |
| `mergedIntoId` | string, optional | Set on a ticket merged into another: the target's `id`. Indexed, but no foreign key (better-auth's drizzle generator can't type a self-reference under `strict`); deleting the target through support nulls it, and an organization's delete takes both, since a merge needs the same organization |
| `replyToken` | string, unique | 128-bit random token in the Reply-To address. Never returned by any endpoint or export |
| `requesterSeenAt` | date, optional | When the requester last saw the ticket |
| `agentSeenAt` | date, optional | When an agent last saw it |
| `lastMessageAt` | date | Orders the lists |
| `solvedAt` | date, optional | When it was last solved; the sweep closes it `autoCloseAfter` later |
| `createdAt`, `updatedAt` | date | |

**`supportCounter`**: operational state for ticket numbers. Left out of exports.

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Primary key |
| `key` | string, unique | `"ticket"` |
| `value` | number | The last number handed out |

**`supportTicketTag`**: one row per tag per ticket.

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Primary key |
| `ticketId` | string → `supportTicket.id`, cascade | |
| `tag` | string | Lowercase, trimmed, 1 to 50 characters of `a-z0-9_-` |

**`supportMessage`**: the thread.

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Primary key |
| `ticketId` | string → `supportTicket.id`, cascade | |
| `kind` | string | `reply`, `note` (internal, never shown to customers) or `event` (a timeline entry with `data`) |
| `authorType` | string | `customer`, `agent` or `system` |
| `userId` | string → `user.id`, set null, optional | The author's account |
| `authorEmail`, `authorName` | string, optional | An account-less sender |
| `body` | string | Plain text. Inbound mail has its quoted text stripped. Empty on events |
| `data` | json, optional | On events: `{ type: "status" \| "assignee" \| "priority" \| "merged" \| "attachment_dropped" \| "followup_of", from?, to? }` |
| `mentions` | json, optional | `string[]` of agent user ids, on agent messages |
| `emailMessageId` | string, unique, optional | The RFC 5322 Message-ID of inbound mail, and of outbound mail when the mailer reports it |
| `channel` | string | `web` or `email`. On events, what caused them: a status change from an email reply, and `attachment_dropped` and `followup_of` rows, are `email` |
| `verified` | boolean | The inbound DKIM result (`false` when SES marked the mail as spam); `true` for in-app messages |
| `createdAt` | date | |

**`supportCannedReply`**: staff-wide saved replies.

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Primary key |
| `title`, `body` | string | |
| `userId` | string → `user.id`, set null, optional | The author |
| `createdAt`, `updatedAt` | date | |

**`supportDelivery`** (only with `mailer`): the outbound queue, one row per mailed reply.

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Primary key |
| `messageId` | string → `supportMessage.id`, cascade | The reply it delivers |
| `ticketId` | string → `supportTicket.id`, cascade | |
| `status` | string | `pending`, `sending`, `sent`, `skipped` or `failed` |
| `scheduledFor` | date | When it is due |
| `claimedAt` | date, optional | When a sweep claimed it. A claim older than `leaseMs` is retried |
| `attempts` | number | Sends tried |
| `detail` | string, optional | The last error, or why it was skipped: `seen`, `note`, `not_a_reply`, `no_address` or `deleted` |
| `providerId` | string, optional | The mailer's id for the send |
| `createdAt` | date | |

There is no recipient column: the address is resolved when the mail is sent.

**`supportAttachment`** (only with `attachments`)

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Primary key |
| `ticketId` | string → `supportTicket.id`, cascade | |
| `messageId` | string → `supportMessage.id`, cascade, optional | Null until attached to a sent message |
| `userId` | string → `user.id`, set null, optional | The uploader |
| `internal` | boolean | Uploaded by an agent for a note; never readable by customers |
| `filename` | string | Sanitized: no path parts, up to 200 characters |
| `contentType` | string | |
| `size` | number | Bytes |
| `storageKey` | string | `support/<organizationId or "_">/<attachmentId>` |
| `createdAt` | date | |

## Export

`exportSupportData(auth, options)` returns all of the package's data, or one organization's, as plain JSON in the schema above, a page at a time. It is server-only; it is not an endpoint.

```ts
import { exportSupportData, type SupportExportPage } from "@byo-oss/support";

let cursor: string | null = null;
do {
  const page: SupportExportPage = await exportSupportData(auth, { cursor, limit: 100 });
  for (const ticket of page.tickets) await importTicket(ticket);
  cursor = page.cursor;
} while (cursor);
```

- **Options:** `organizationId?` (only that organization's tickets, and no canned replies), `cursor?` (from the previous page) and `limit?` (1 to 500, default 100).
- **A ticket** has every field except `replyToken`, plus `userEmail` (the requester's current email), `assigneeEmail`, `tags`, `messages` (oldest first, notes and events included, each with `userEmail` and its `deliveries`) and `attachments` (metadata, with the uploader's `userEmail`; `storageKey` locates the blob so you can copy it). Dates are ISO strings.
- **`replyToken` is never exported:** it lets mail be posted into a ticket, and exports go to other tools.
- **Canned replies** (with the author's `userEmail`) come on the first page of an export without `organizationId`.
- **Paging** is a keyset on ticket `number`, so a ticket deleted mid-export never makes another one skip, and tickets created mid-export come on later pages. `cursor` is `null` on the last page.
- **Left out:** `supportCounter`, which is operational state.
- Deliveries exist only with a `mailer`, attachments only with `attachments`; otherwise those lists are empty. Inside a better-auth transaction (`runWithTransaction`), it reads in that transaction.

## What this is not (yet)

A helpdesk for a young product: one shared queue, plain text threads, email in and out, no SLA clock. Not here: SLAs and an automation or rule builder, multiple brands, social and chat channels (Slack, WhatsApp), live chat over websockets (the UI polls), AI auto-replies, saved views, merging tickets from different requesters or organizations, snooze and away status, an auto-acknowledge email for email-only senders, signed rating links in email, anonymous widget visitors, apps without the organization plugin, and shipped translations (the `labels` defaults are English). For those, see [Outgrowing this](#outgrowing-this).

Known limits:

- **Tags.** `listSupportTags` reads at most 10,000 tag rows and dedupes in code (the adapter has no `DISTINCT`), so a store with more than that lists a subset. A ticket's own tags are read the same way.
- **Search.** `q` matches a ticket number exactly (`#123` or `123`); anything else is a case-insensitive "subject contains". It doesn't search message bodies, and the subject isn't indexed, so it scans on a very large table.
- **Plain text.** Messages are plain text. Attachments are linked in mail, not attached.
- **Email-only people** can't see their ticket in the app; they live in their inbox. Tickets opened by mail have no organization.
- **Inbound needs Node.** DKIM verification reads DNS through Node's `dns`, so `/support/inbound` doesn't run on edge runtimes.

## Outgrowing this

You've outgrown it when you have more than about 10 agents, need SLAs or automation rules, answer on the phone, in chat or on social channels, need CSAT reporting, run several brands, or want a help center and AI replies. The usual next stops are [Zendesk](https://developer.zendesk.com/api-reference/ticketing/tickets/ticket_import/), [Plain](https://www.plain.com/docs/graphql/threads/import), [Front](https://dev.frontapp.com/reference/import-inbox-message) and [Help Scout](https://developer.helpscout.com/mailbox-api/endpoints/conversations/create/). Each has a way to import past conversations; `exportSupportData` gives you the rows to feed it.

Mapping to Zendesk's [ticket import](https://developer.zendesk.com/api-reference/ticketing/tickets/ticket_import/) (`POST /api/v2/imports/tickets`, or `create_many` for up to 100 at a time):

| Here | Zendesk |
|---|---|
| `id` | `external_id` |
| `number` | Not settable. Keep it in a tag such as `ticket-123` |
| `subject` | `subject` |
| `status` | `status`: the same four strings (`open`, `pending`, `solved`, `closed`) |
| `priority` | `priority`: the same strings (`low`, `normal`, `high`, `urgent`) |
| `tags` | `tags`, sanitized to Zendesk's rules |
| `channel` | `via.channel` (`web` or `email`), plus a tag if you want to filter on it |
| `assigneeEmail` | `assignee_id`, looked up by email |
| `userEmail`, or `requesterEmail` and `requesterName` | `requester_id`, created first with [`users/create_many`](https://developer.zendesk.com/api-reference/ticketing/users/users/#create-many-users) |
| `organizationId` | `organization_id`, after creating the organizations |
| `createdAt`, `updatedAt`, `solvedAt` | `created_at`, `updated_at`, `solved_at` |
| `messages` of kind `reply` and `note` | `comments[]`: `body`, `created_at`, `public` (`false` for `note`), `author_id` looked up by the message's `userEmail` (or `authorEmail`) |
| `messages` of kind `event` | No equivalent. Skip them, or import as private comments |
| `attachments` | Copy each blob by `storageKey`, upload it to Zendesk, and attach the token to the comment |
| `rating` | A tag `csat:good` or `csat:bad`: ratings can't be imported natively |
| `verified`, `visibility`, `mergedIntoId` | No equivalent. Tag `verified: false` tickets if you want to review them; skip merged sources |
| canned replies | Zendesk macros |
| `supportDelivery`, `supportCounter` | No equivalent; they stay here |

Plain's `importThread` is idempotent, which makes a re-run safe; Front and Help Scout take a conversation with its messages in a similar shape.

1. **Run both.** Set the new tool up with its own address and forward a test inbox to it, while support keeps serving customers. Build and check the field mapping on a few tickets.
2. **Backfill.** Loop `exportSupportData` until `cursor` is `null`, creating users and organizations first, then tickets with their comments and attachments.
3. **Cut over.** Point your support address and the in-app entry point at the new tool, stop calling `processSupportDeliveries`, and stop routing support events to notifications (or point them at the new tool's webhooks). Keep the old tables as the archive until you're sure.
4. **Uninstall** once nothing reads the old queue: see below.

## Uninstall

Remove `support()` from `betterAuth({ plugins })` (keep `organization()` if you use it), `supportClient()` from your auth client, `SupportWidget`, `SupportInbox` and the hooks from your UI, the cron that calls `processSupportDeliveries`, the inbound route at your mail relay, and the Tailwind `@source` line.

Then drop the tables, children before the tables they reference. Use the names your adapter or the `schema` option gave them; the quotes keep the camelCase names (MySQL uses backticks):

```sql
DROP TABLE IF EXISTS "supportAttachment";
DROP TABLE IF EXISTS "supportDelivery";
DROP TABLE IF EXISTS "supportMessage";
DROP TABLE IF EXISTS "supportTicketTag";
DROP TABLE IF EXISTS "supportCannedReply";
DROP TABLE IF EXISTS "supportTicket";
DROP TABLE IF EXISTS "supportCounter";
```

If your tables were generated with snake_case names (better-auth's drizzle generator does this unless the adapter is set to camelCase), drop `support_attachment`, `support_delivery`, `support_message`, `support_ticket_tag`, `support_canned_reply`, `support_ticket` and `support_counter` instead, in the same order, without quotes.

`supportAttachment` and `supportDelivery` exist only if you used `attachments` and `mailer`; `IF EXISTS` covers both cases. No foreign key points at any support table from outside this list.

Last, delete the `support/` prefix in your attachment bucket (`aws s3 rm s3://YOUR_BUCKET/support/ --recursive`), if you used `attachments`.

The plugin adds no columns to better-auth's own tables (`user`, `organization`, `member`), so there is nothing else to clean up.

## Community adapters

The provider interfaces are `Mailer` (from `@byo-oss/mailer`), `SupportInboundSource` and `SupportStorage`, all exported as named types. Community adapters are separate packages outside the `@byo-oss` scope, named `byo-support-<provider>` (for example `byo-support-gcs`), or the same under your own scope. They depend on this package's types and nothing else of ours. Run the contract suites against yours: `testSupportInboundSource` and `testSupportStorage` from `@byo-oss/support/testing` (ESM only, needs `vitest`), and `testMailer` from `@byo-oss/mailer/testing`. Each takes a required `failing` factory, so the retry check always runs.

No community adapters are known yet. Open a pull request to list yours here.

## MongoDB

MongoDB's better-auth adapter creates none of the indexes support's fields declare. Create unique indexes on `supportCounter.key`, `supportTicket.number`, `supportTicket.replyToken` and `supportMessage.emailMessageId` yourself: ticket numbering and inbound de-duplication rely on them. Without foreign keys, deleting tickets, organizations and users goes through the cleanup code described under [Lifecycle](#lifecycle).

## Tailwind

Tailwind v4 skips `node_modules` when it scans for classes, so point it at the package from your CSS or some of the components' classes won't be generated:

```css
@import "tailwindcss";
@source "../node_modules/@byo-oss/support/dist"; /* path relative to this CSS file */
```

The components are styled with Tailwind classes only: without Tailwind they render unstyled (they still work).

The components use shadcn's theme tokens, with no UI runtime dependencies and no shadcn required: `background`, `foreground`, `border`, `ring`, `accent`, `accent-foreground`, `muted`, `muted-foreground`, `primary`, `primary-foreground`, `popover`, `popover-foreground` and `destructive`. Define those CSS variables (a shadcn theme does). Destructive confirm buttons are `bg-destructive text-white`, as shadcn's own destructive button is, so they don't need `destructive-foreground`, which current shadcn themes don't define. Status dots, the high-priority pill and internal notes also use Tailwind's default `sky`, `amber` and `emerald` palettes (with `dark:` variants), so keep the default palette or define those colors.

Class props append to the component's own classes; they never replace them. Pass `className` for the root (for the inline widget, the panel) and `listClassName`, `threadClassName`, `messageClassName`, `composerClassName`, `buttonClassName` and `fieldClassName` (on the inbox, `queueClassName` instead of `listClassName`) for the parts. On the widget, `buttonClassName` is the launcher's; on the inbox it goes on every action button. `fieldClassName` goes on every text input, select and textarea of either component.

There is no class merging: your classes are added after the defaults as they are, and nothing like `tailwind-merge` removes a default that conflicts. When both set the same property (`p-4` on top of the component's `p-3`, say), the order of the rules in the generated CSS decides, not the order of the classes, so yours may lose. To win, use Tailwind's `!` important modifier (`p-4!`) or a more specific variant or selector. Running your own string through a merge helper (`cn(...)`) only tidies that string; it can't take a default away.

## License

MIT
