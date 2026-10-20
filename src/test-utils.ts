/**
 * Test harness for the memory lane (and, through `wrapAdapter`, the SQL lane).
 * Not part of the package: tests import it, nothing in `src/` else does.
 */
import { getAuthTables } from "@better-auth/core/db";
import { type MemoryDB, memoryAdapter } from "@better-auth/memory-adapter";
import {
  type AuthContext,
  type BetterAuthOptions,
  type BetterAuthPlugin,
  betterAuth,
  type DBAdapter,
} from "better-auth";
import { createAccessControl } from "better-auth/plugins/access";
import { organization } from "better-auth/plugins/organization";
import {
  adminAc,
  defaultStatements,
  memberAc,
  ownerAc,
} from "better-auth/plugins/organization/access";
import { afterEach } from "vitest";
import { IN_CHUNK, isSupportQuery } from "./adapter";
import { allocateTicketNumber } from "./counter";
import { type SupportOptions, support } from "./index";
import type {
  SupportMessageRow,
  SupportTicketRow,
  SupportTicketTagRow,
} from "./schema";
import { type SupportAction, supportStatements } from "./statements";
import { createReplyToken } from "./token";

// ---------------------------------------------------------------------------
// Strict adapter wrapper (SPEC §2.7, checkable on every lane)
// ---------------------------------------------------------------------------

/** One adapter call as the wrapper sees it. */
export type AdapterCall = {
  method: string;
  model: string;
  /** The argument object as passed (where, limit, data, ...). */
  args: Record<string, unknown>;
};

export type WrapAdapterOptions = {
  /** Enforce SPEC §2.7 on support's queries. @default true */
  strict?: boolean;
  /** Runs before every adapter call (also inside transactions), e.g. to force a conflict. */
  before?: (call: AdapterCall) => void | Promise<void>;
};

const strictViolations: string[] = [];

/**
 * Returns and clears the violations recorded since the last call. A test that
 * provokes a violation on purpose calls this so the `afterEach` check passes.
 */
export function takeStrictViolations(): string[] {
  return strictViolations.splice(0, strictViolations.length);
}

// A violation inside code that catches errors (lifecycle hooks, emit) would be
// swallowed; recording it here fails the test anyway.
afterEach(() => {
  const violations = takeStrictViolations();
  if (violations.length > 0) {
    throw new Error(`strict adapter violations:\n${violations.join("\n")}`);
  }
});

const WHERE_METHODS = new Set([
  "findOne",
  "findMany",
  "count",
  "update",
  "updateMany",
  "delete",
  "deleteMany",
  "consumeOne",
  "incrementOne",
]);

function checkCall(method: string, args: Record<string, unknown>) {
  const model = String(args.model);
  // every call on support's own models; member/user only when made through
  // support's adapter.ts helpers, so better-auth's own queries pass untouched
  if (!model.startsWith("support") && !isSupportQuery(args)) return;
  const problems: string[] = [];
  if (method === "findMany" && args.limit === undefined) {
    problems.push(`findMany on ${model} without limit`);
  }
  if (WHERE_METHODS.has(method) && Array.isArray(args.where)) {
    for (const clause of args.where as {
      field: string;
      operator?: string;
      value: unknown;
    }[]) {
      if (clause.operator !== "in" && clause.operator !== "not_in") continue;
      const size = Array.isArray(clause.value) ? clause.value.length : -1;
      if (size <= 0 || size > IN_CHUNK) {
        problems.push(
          `${method} on ${model}: ${clause.field} ${clause.operator} with ${size < 0 ? "a non-list" : size} values (allowed 1..${IN_CHUNK})`,
        );
      }
    }
  }
  if (problems.length > 0) {
    strictViolations.push(...problems);
    throw new Error(`[strict adapter] ${problems.join("; ")}`);
  }
}

const WRAPPED = [
  "create",
  "findOne",
  "findMany",
  "count",
  "update",
  "updateMany",
  "delete",
  "deleteMany",
  "consumeOne",
  "incrementOne",
] as const;

/**
 * Wraps an adapter so every call runs `options.before` and (with `strict`)
 * fails on a support `findMany` without `limit` or an `in`/`not_in` list of 0
 * or more than 90 values. The transaction adapter is wrapped too.
 */
export function wrapAdapter<A extends Omit<DBAdapter, "transaction">>(
  adapter: A,
  options: WrapAdapterOptions = {},
): A {
  const { strict = true, before } = options;
  const wrapped: Record<string, unknown> = { ...adapter };
  for (const method of WRAPPED) {
    const original = (adapter as Record<string, unknown>)[method] as
      | ((args: Record<string, unknown>) => Promise<unknown>)
      | undefined;
    if (!original) continue;
    wrapped[method] = async (args: Record<string, unknown>) => {
      if (strict) checkCall(method, args);
      if (before) await before({ method, model: String(args.model), args });
      return original.call(adapter, args);
    };
  }
  const transaction = (adapter as { transaction?: unknown }).transaction as
    | (<R>(
        cb: (trx: Omit<DBAdapter, "transaction">) => Promise<R>,
      ) => Promise<R>)
    | undefined;
  if (transaction) {
    wrapped.transaction = <R>(
      cb: (trx: Omit<DBAdapter, "transaction">) => Promise<R>,
    ) => transaction.call(adapter, (trx) => cb(wrapAdapter(trx, options)));
  }
  return wrapped as A;
}

/** Wraps an adapter factory (`memoryAdapter(db)`, `kyselyAdapter(db)`) with `wrapAdapter`. */
export function wrapAdapterFactory(
  factory: (options: BetterAuthOptions) => DBAdapter,
  options: WrapAdapterOptions = {},
): (options: BetterAuthOptions) => DBAdapter {
  return (authOptions) => wrapAdapter(factory(authOptions), options);
}

// ---------------------------------------------------------------------------
// Roles: support statements spread into the app's access control (setup step)
// ---------------------------------------------------------------------------

const ALL_ACTIONS = [...supportStatements.support];
const without = (action: SupportAction) =>
  ALL_ACTIONS.filter((a) => a !== action);

export const testStatements = {
  ...defaultStatements,
  ...supportStatements,
} as const;
export const testAc = createAccessControl(testStatements);

/**
 * Global roles (the org plugin applies them in every organization):
 * - `owner`, `admin`: their default org permissions plus every support action
 * - `member`: read, reply, update
 * - `billing`: no support actions (a staff member who is not an agent)
 * - `readOnly`: support read only
 * - `lacksRead` … `lacksDelete`: every support action except the named one
 */
export const testRoles = {
  owner: testAc.newRole({ ...ownerAc.statements, support: ALL_ACTIONS }),
  admin: testAc.newRole({ ...adminAc.statements, support: ALL_ACTIONS }),
  member: testAc.newRole({
    ...memberAc.statements,
    support: ["read", "reply", "update"],
  }),
  billing: testAc.newRole({ ...memberAc.statements }),
  readOnly: testAc.newRole({ ...memberAc.statements, support: ["read"] }),
  lacksRead: testAc.newRole({
    ...memberAc.statements,
    support: without("read"),
  }),
  lacksReply: testAc.newRole({
    ...memberAc.statements,
    support: without("reply"),
  }),
  lacksUpdate: testAc.newRole({
    ...memberAc.statements,
    support: without("update"),
  }),
  lacksManage: testAc.newRole({
    ...memberAc.statements,
    support: without("manage"),
  }),
  lacksDelete: testAc.newRole({
    ...memberAc.statements,
    support: without("delete"),
  }),
};

export type TestRole = keyof typeof testRoles;

/** The organization plugin as tests install it. */
export const testOrganization = () =>
  organization({ ac: testAc, roles: testRoles });

// ---------------------------------------------------------------------------
// betterAuth on the memory adapter
// ---------------------------------------------------------------------------

/** Id of the staff organization `seedSupportWorld` creates. Pass it as `staffOrganizationId`. */
export const STAFF_ORG_ID = "org_staff";

export const TEST_PASSWORD = "password-1234";

/** better-auth options shared by both lanes. Passwords are not hashed, to keep tests fast. */
export const baseAuthOptions = {
  baseURL: "http://localhost:3000",
  secret: "byo-support-test-secret-0123456789abcdef",
  emailAndPassword: {
    enabled: true,
    password: {
      hash: async (password: string) => `plain:${password}`,
      verify: async ({ hash, password }: { hash: string; password: string }) =>
        hash === `plain:${password}`,
    },
  },
  // the admin plugin's field, so tests can mark a session as impersonated
  session: {
    additionalFields: {
      impersonatedBy: { type: "string", required: false, input: false },
    },
  },
} satisfies Partial<BetterAuthOptions>;

export type TestAuthConfig = {
  /** Extra better-auth options (merged over the base). */
  authOptions?: Partial<BetterAuthOptions>;
  /** Plugins after organization() and support(). */
  plugins?: BetterAuthPlugin[];
  /** Install the organization plugin. @default true */
  organization?: boolean;
  /** Adapter wrapper options. @default { strict: true } */
  adapter?: WrapAdapterOptions;
};

function seededMemoryDB(options: BetterAuthOptions): MemoryDB {
  const tables = getAuthTables(options);
  return Object.keys(tables).reduce<MemoryDB>((db, table) => {
    db[table] = [];
    return db;
  }, {});
}

/**
 * A real `betterAuth` with `organization({ ac, roles })` (unless turned off),
 * `support(opts)` and the memory adapter behind the strict wrapper.
 */
export function createTestAuth(
  opts: SupportOptions = {},
  config: TestAuthConfig = {},
) {
  const plugins = [
    ...(config.organization === false ? [] : [testOrganization()]),
    support(opts),
    ...(config.plugins ?? []),
  ];
  const options = { ...baseAuthOptions, ...config.authOptions, plugins };
  const memoryDB = seededMemoryDB(options);
  return betterAuth({
    ...options,
    database: wrapAdapterFactory(memoryAdapter(memoryDB), config.adapter),
  });
}

/** The typed auth `createTestAuth` returns. */
export type TestAuth = ReturnType<typeof createTestAuth>;

/**
 * Any test auth (memory or SQL lane). Loose on purpose so helpers work with
 * both; tests keep their own typed instance for `auth.api` calls.
 */
// biome-ignore lint/suspicious/noExplicitAny: helpers accept either lane's auth
export type AnyTestAuth = { api: any; $context: Promise<any> };

/** better-auth's context (adapter, internalAdapter, options) of a test auth. */
export async function getContext(auth: AnyTestAuth): Promise<AuthContext> {
  return (await auth.$context) as AuthContext;
}

// ---------------------------------------------------------------------------
// Users, sessions, organizations
// ---------------------------------------------------------------------------

export type TestUser = {
  user: { id: string; email: string; name: string; emailVerified: boolean };
  /** A cookie for this user's session. */
  headers: Headers;
};

const cookieFrom = (headers: Headers) =>
  new Headers({
    cookie: headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; "),
  });

/**
 * Signs up a user (email/password) and returns them with session headers.
 * `verified: true` then sets `emailVerified` through the internal adapter, so
 * `user.update.after` hooks run as they would on real verification.
 */
export async function signUpUser(
  auth: AnyTestAuth,
  email: string,
  options: { name?: string; verified?: boolean } = {},
): Promise<TestUser> {
  const { headers, response } = await auth.api.signUpEmail({
    body: {
      email,
      password: TEST_PASSWORD,
      name: options.name ?? email.split("@")[0] ?? email,
    },
    returnHeaders: true,
  });
  let user = response.user as TestUser["user"];
  if (options.verified) user = await verifyEmail(auth, user.id);
  return { user, headers: cookieFrom(headers as Headers) };
}

/** Marks a user's email verified through better-auth (runs `user.update.after` hooks). */
export async function verifyEmail(
  auth: AnyTestAuth,
  userId: string,
): Promise<TestUser["user"]> {
  const context = await getContext(auth);
  const updated = await context.internalAdapter.updateUser(userId, {
    emailVerified: true,
  });
  return updated as TestUser["user"];
}

/** Signs the user in again and returns headers for a new session. */
export async function signIn(
  auth: AnyTestAuth,
  email: string,
): Promise<Headers> {
  const { headers } = await auth.api.signInEmail({
    body: { email, password: TEST_PASSWORD },
    returnHeaders: true,
  });
  return cookieFrom(headers as Headers);
}

/**
 * Headers for a new session of this user that an admin is impersonating
 * (`session.impersonatedBy` set, as the admin plugin does).
 */
export async function impersonatedHeaders(
  auth: AnyTestAuth,
  email: string,
  adminId = "admin-user",
): Promise<Headers> {
  const headers = await signIn(auth, email);
  const session = await auth.api.getSession({ headers });
  const context = await getContext(auth);
  await context.adapter.update({
    model: "session",
    where: [{ field: "id", value: session.session.id }],
    update: { impersonatedBy: adminId },
  });
  return headers;
}

/** Creates an organization through the org plugin, owned by the caller. */
export async function createOrganization(
  auth: AnyTestAuth,
  owner: TestUser,
  input: { name: string; slug?: string },
): Promise<{ id: string; name: string; slug: string }> {
  return auth.api.createOrganization({
    body: {
      name: input.name,
      slug: input.slug ?? input.name.toLowerCase().replace(/\W+/g, "-"),
    },
    headers: owner.headers,
  });
}

/** Adds a member through the org plugin's server-only `addMember`. */
export async function addMember(
  auth: AnyTestAuth,
  input: {
    organizationId: string;
    userId: string;
    role: TestRole | TestRole[];
  },
): Promise<{
  id: string;
  userId: string;
  organizationId: string;
  role: string;
}> {
  return auth.api.addMember({ body: input });
}

/** Removes a member through the org plugin's endpoint, as `by` (who needs the right to). */
export async function removeMember(
  auth: AnyTestAuth,
  input: { organizationId: string; member: TestUser; by: TestUser },
): Promise<unknown> {
  return auth.api.removeMember({
    body: {
      organizationId: input.organizationId,
      memberIdOrEmail: input.member.user.email,
    },
    headers: input.by.headers,
  });
}

/**
 * Creates the staff organization with a fixed id (so it can be passed as
 * `staffOrganizationId` before the org exists) and makes `owner` its owner.
 */
export async function createStaffOrganization(
  auth: AnyTestAuth,
  owner: TestUser,
  id = STAFF_ORG_ID,
): Promise<{ id: string }> {
  const context = await getContext(auth);
  await context.adapter.create({
    model: "organization",
    data: { id, name: "Staff", slug: id, createdAt: new Date() },
    forceAllowId: true,
  });
  await addMember(auth, {
    organizationId: id,
    userId: owner.user.id,
    role: "owner",
  });
  return { id };
}

export type SupportTestWorld = {
  staffOrganizationId: string;
  /** One staff member per role, keyed by role. */
  agents: Record<TestRole, TestUser>;
  /** A customer organization owned by `customer`, with `teammate` as a member. */
  customerOrg: { id: string };
  /** Verified customer, owner of `customerOrg`. */
  customer: TestUser;
  /** Verified customer, `member` of `customerOrg`. */
  teammate: TestUser;
  /** Verified user in no organization. */
  outsider: TestUser;
};

/**
 * Seeds the people most tests need: a staff org (`STAFF_ORG_ID`) with one
 * staff member per test role, a customer org with an owner and a teammate,
 * and an outsider. Create the auth with `staffOrganizationId: STAFF_ORG_ID`.
 */
export async function seedSupportWorld(
  auth: AnyTestAuth,
  staffOrganizationId = STAFF_ORG_ID,
): Promise<SupportTestWorld> {
  const roles = Object.keys(testRoles) as TestRole[];
  const agents = {} as Record<TestRole, TestUser>;
  for (const role of roles) {
    agents[role] = await signUpUser(auth, `${role.toLowerCase()}@staff.test`, {
      name: `Agent ${role}`,
      verified: true,
    });
  }
  await createStaffOrganization(auth, agents.owner, staffOrganizationId);
  for (const role of roles) {
    if (role === "owner") continue;
    await addMember(auth, {
      organizationId: staffOrganizationId,
      userId: agents[role].user.id,
      role,
    });
  }
  const customer = await signUpUser(auth, "customer@acme.test", {
    name: "Cora Customer",
    verified: true,
  });
  const teammate = await signUpUser(auth, "teammate@acme.test", {
    name: "Tim Teammate",
    verified: true,
  });
  const outsider = await signUpUser(auth, "outsider@other.test", {
    name: "Olga Outsider",
    verified: true,
  });
  const customerOrg = await createOrganization(auth, customer, {
    name: "Acme",
    slug: "acme",
  });
  await addMember(auth, {
    organizationId: customerOrg.id,
    userId: teammate.user.id,
    role: "member",
  });
  return {
    staffOrganizationId,
    agents,
    customerOrg: { id: customerOrg.id },
    customer,
    teammate,
    outsider,
  };
}

// ---------------------------------------------------------------------------
// Row seeders: raw inserts with every required field filled, for tests that
// must not depend on tickets.ts (G16). They go through the wrapped adapter.
// ---------------------------------------------------------------------------

/**
 * Inserts a ticket row directly. Defaults: `status: "open"`,
 * `channel: "web"`, `visibility: "private"`, `verified: true`, a fresh reply
 * token, a number from `allocateTicketNumber` (unless `number` is given), and
 * all dates now. No first message, no event.
 */
export async function insertTicket(
  auth: AnyTestAuth,
  overrides: Partial<Omit<SupportTicketRow, "id">> = {},
): Promise<SupportTicketRow> {
  const { adapter } = await getContext(auth);
  const now = new Date();
  const number = overrides.number ?? (await allocateTicketNumber(adapter));
  return adapter.create<Omit<SupportTicketRow, "id">, SupportTicketRow>({
    model: "supportTicket",
    data: {
      subject: `Ticket ${number}`,
      status: "open",
      channel: "web",
      visibility: "private",
      verified: true,
      replyToken: createReplyToken(),
      lastMessageAt: now,
      createdAt: now,
      updatedAt: now,
      ...overrides,
      number,
    },
  });
}

/**
 * Inserts a message row directly. Defaults: `kind: "reply"`,
 * `authorType: "customer"`, `body: "Hello"`, `channel: "web"`,
 * `verified: true`, `createdAt` now. Does not touch the ticket.
 */
export async function insertMessage(
  auth: AnyTestAuth,
  overrides: Partial<Omit<SupportMessageRow, "id">> & { ticketId: string },
): Promise<SupportMessageRow> {
  const { adapter } = await getContext(auth);
  return adapter.create<Omit<SupportMessageRow, "id">, SupportMessageRow>({
    model: "supportMessage",
    data: {
      kind: "reply",
      authorType: "customer",
      body: "Hello",
      channel: "web",
      verified: true,
      createdAt: new Date(),
      ...overrides,
    },
  });
}

/** Inserts a tag row directly (pass it already normalized). */
export async function insertTag(
  auth: AnyTestAuth,
  input: { ticketId: string; tag: string },
): Promise<SupportTicketTagRow> {
  const { adapter } = await getContext(auth);
  return adapter.create<Omit<SupportTicketTagRow, "id">, SupportTicketTagRow>({
    model: "supportTicketTag",
    data: input,
  });
}
