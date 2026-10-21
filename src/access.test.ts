import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  checkSession,
  defaultAuthorize,
  defaultIsAgent,
  myOrganizationIds,
  requireAgent,
  requireCustomer,
  type SupportEndpointContext,
} from "./access";
import { authRuntime, type UserSummary } from "./adapter";
import { SUPPORT_ERROR_CODES } from "./error-codes";
import type {
  SupportAuthorizeInput,
  SupportOptions,
  SupportSession,
} from "./options";
import type { SupportMessageRow, SupportTicketRow } from "./schema";
import {
  toAgentMessage,
  toAgentTicket,
  toCustomerMessage,
  toCustomerTicket,
} from "./serialize";
import { type SupportAction, supportStatements } from "./statements";
import {
  type AnyTestAuth,
  createOrganization,
  createTestAuth,
  getContext,
  impersonatedHeaders,
  insertTicket,
  removeMember,
  STAFF_ORG_ID,
  type SupportTestWorld,
  seedSupportWorld,
  type TestUser,
} from "./test-utils";

const ACTIONS = [...supportStatements.support] as SupportAction[];

/**
 * An endpoint context as `sessionMiddleware` leaves it: better-auth's context
 * with `session` set from the caller's cookie (or null), plus the support
 * plugin's resolved options. The route factories are other nodes' work, so
 * the gates are called directly.
 */
async function gate(auth: AnyTestAuth, headers?: Headers) {
  const context = await getContext(auth);
  const session = headers
    ? ((await auth.api.getSession({ headers })) as SupportSession | null)
    : null;
  const ctx = {
    context: Object.assign(Object.create(context), { session }),
    headers: headers ?? new Headers(),
  } as unknown as SupportEndpointContext;
  const { opts } = await authRuntime(auth, "test");
  return { ctx, opts, session, adapter: context.adapter };
}

const asAgent = async (
  auth: AnyTestAuth,
  user: TestUser,
  action: SupportAction | SupportAction[],
) => {
  const { ctx, opts } = await gate(auth, user.headers);
  return requireAgent(ctx, opts, action);
};

const error = (status: string, code?: { code: string }) =>
  expect.objectContaining({
    status,
    ...(code ? { body: expect.objectContaining({ code: code.code }) } : {}),
  });

const notAllowed = error("FORBIDDEN", SUPPORT_ERROR_CODES.NOT_ALLOWED);
const notAccepted = error(
  "FORBIDDEN",
  SUPPORT_ERROR_CODES.SESSION_NOT_ACCEPTED,
);
const notFound = error("NOT_FOUND", SUPPORT_ERROR_CODES.TICKET_NOT_FOUND);

async function world(opts: SupportOptions = {}) {
  const auth = createTestAuth({ staffOrganizationId: STAFF_ORG_ID, ...opts });
  return { auth, world: await seedSupportWorld(auth) };
}

describe("default authorize (staff org via the org plugin's hasPermission)", () => {
  let auth: AnyTestAuth;
  let w: SupportTestWorld;
  beforeAll(async () => {
    ({ auth, world: w } = await world());
  });

  it("allows a staff member whose role grants the action, with another org active", async () => {
    const agent = w.agents.member;
    const side = await createOrganization(auth, agent, { name: "Side" });
    await auth.api.setActiveOrganization({
      body: { organizationId: side.id },
      headers: agent.headers,
    });
    const { session } = await gate(auth, agent.headers);
    const active = (
      session?.session as { activeOrganizationId?: string | null } | undefined
    )?.activeOrganizationId;
    expect(active).toBe(side.id);
    expect(active).not.toBe(STAFF_ORG_ID);

    for (const action of ["read", "reply", "update"] as const) {
      const result = await asAgent(auth, agent, action);
      expect(result.user.id).toBe(agent.user.id);
    }
    await expect(
      asAgent(auth, agent, ["read", "reply", "update"]),
    ).resolves.toBeTruthy();
    // owner of the active org, but `member` in the staff org: no delete
    await expect(asAgent(auth, agent, "delete")).rejects.toEqual(notAllowed);
    await expect(asAgent(auth, agent, ["read", "delete"])).rejects.toEqual(
      notAllowed,
    );
  });

  it("allows owner and admin every action", async () => {
    for (const role of ["owner", "admin"] as const) {
      for (const action of ACTIONS) {
        await expect(
          asAgent(auth, w.agents[role], action),
        ).resolves.toBeTruthy();
      }
    }
  });

  it("denies a customer-org owner, even with their org active (their role grants support:* there)", async () => {
    await auth.api.setActiveOrganization({
      body: { organizationId: w.customerOrg.id },
      headers: w.customer.headers,
    });
    for (const action of ACTIONS) {
      await expect(asAgent(auth, w.customer, action)).rejects.toEqual(
        notAllowed,
      );
    }
    await expect(asAgent(auth, w.outsider, "read")).rejects.toEqual(notAllowed);
  });

  it("denies a staff member whose role has no support actions", async () => {
    for (const action of ACTIONS) {
      await expect(asAgent(auth, w.agents.billing, action)).rejects.toEqual(
        notAllowed,
      );
    }
  });

  it("allows readOnly to read and nothing else", async () => {
    await expect(
      asAgent(auth, w.agents.readOnly, "read"),
    ).resolves.toBeTruthy();
    for (const action of ACTIONS.filter((a) => a !== "read")) {
      await expect(asAgent(auth, w.agents.readOnly, action)).rejects.toEqual(
        notAllowed,
      );
    }
  });

  it.each([
    ["lacksRead", "read"],
    ["lacksReply", "reply"],
    ["lacksUpdate", "update"],
    ["lacksManage", "manage"],
    ["lacksDelete", "delete"],
  ] as const)("denies %s exactly %s", async (role, missing) => {
    const agent = w.agents[role];
    await expect(asAgent(auth, agent, missing)).rejects.toEqual(notAllowed);
    for (const action of ACTIONS.filter((a) => a !== missing)) {
      await expect(asAgent(auth, agent, action)).resolves.toBeTruthy();
    }
  });

  it("answers false itself for no org id, no member row, or a missing role grant", async () => {
    const { ctx, opts, session } = await gate(auth, w.agents.owner.headers);
    const input = {
      session: session as SupportSession,
      headers: new Headers(),
      permissions: { support: ["read"] },
    };
    expect(
      await defaultAuthorize(ctx, opts, {
        ...input,
        organizationId: STAFF_ORG_ID,
      }),
    ).toBe(true);
    expect(await defaultAuthorize(ctx, opts, input)).toBe(false);
    expect(
      await defaultAuthorize(ctx, opts, {
        ...input,
        organizationId: "org_missing",
      }),
    ).toBe(false);
    const billing = await gate(auth, w.agents.billing.headers);
    expect(
      await defaultAuthorize(billing.ctx, billing.opts, {
        ...input,
        session: billing.session as SupportSession,
        organizationId: STAFF_ORG_ID,
      }),
    ).toBe(false);
  });
});

describe("without a staff organization", () => {
  it("denies every action to everyone when there is no custom authorize", async () => {
    const auth = createTestAuth({});
    const w = await seedSupportWorld(auth, STAFF_ORG_ID);
    for (const agent of [w.agents.owner, w.agents.admin, w.customer]) {
      for (const action of ACTIONS) {
        await expect(asAgent(auth, agent, action)).rejects.toEqual(notAllowed);
      }
    }
    const { ctx, opts } = await gate(auth, w.agents.owner.headers);
    expect(await defaultIsAgent(ctx, opts, w.agents.owner.user.id)).toBe(false);
  });
});

describe("custom authorize", () => {
  it("receives { session, headers, organizationId: staffOrganizationId, permissions } and decides", async () => {
    const authorize = vi.fn(
      ({ permissions }: { permissions: Record<string, string[]> }) =>
        !permissions.support?.includes("delete"),
    );
    const { auth, world: w } = await world({ authorize });
    const { ctx, opts, session } = await gate(auth, w.customer.headers);

    await expect(requireAgent(ctx, opts, "reply")).resolves.toEqual(session);
    expect(authorize).toHaveBeenCalledTimes(1);
    const input = authorize.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(input).sort()).toEqual(
      ["headers", "organizationId", "permissions", "session"].sort(),
    );
    expect(input).toEqual({
      session,
      headers: ctx.headers,
      organizationId: STAFF_ORG_ID,
      permissions: { support: ["reply"] },
    });
    expect(input.headers).toBe(ctx.headers);

    await requireAgent(ctx, opts, ["read", "update"]);
    expect(authorize.mock.calls[1]?.[0]).toMatchObject({
      organizationId: STAFF_ORG_ID,
      permissions: { support: ["read", "update"] },
    });
    // a customer allowed by the app's rule: the default is not consulted
    await expect(requireAgent(ctx, opts, "delete")).rejects.toEqual(notAllowed);
  });

  it("gets organizationId undefined without a staff org", async () => {
    const authorize = vi.fn((_input: SupportAuthorizeInput) => true);
    const auth = createTestAuth({ authorize });
    const w = await seedSupportWorld(auth, STAFF_ORG_ID);
    await asAgent(auth, w.outsider, "read");
    expect(authorize.mock.calls[0]?.[0]).toMatchObject({
      organizationId: undefined,
      permissions: { support: ["read"] },
    });
  });
});

describe("session acceptance", () => {
  let auth: AnyTestAuth;
  let w: SupportTestWorld;
  let ticket: SupportTicketRow;
  beforeAll(async () => {
    ({ auth, world: w } = await world());
    ticket = await insertTicket(auth, { userId: w.customer.user.id });
  });

  it("accepts normal sessions", async () => {
    const customer = await gate(auth, w.customer.headers);
    await expect(
      checkSession(customer.ctx, customer.opts, "customer"),
    ).resolves.toEqual(customer.session);
    await expect(
      requireCustomer(customer.ctx, customer.opts, ticket, "requester"),
    ).resolves.toMatchObject({ role: "requester" });
    await expect(asAgent(auth, w.agents.owner, "delete")).resolves.toBeTruthy();
  });

  it("refuses impersonated sessions by default, on customer and agent gates", async () => {
    const customer = await gate(
      auth,
      await impersonatedHeaders(auth, w.customer.user.email),
    );
    expect(customer.session?.session.impersonatedBy).toBe("admin-user");
    await expect(
      checkSession(customer.ctx, customer.opts, "customer"),
    ).rejects.toEqual(notAccepted);
    for (const need of ["read", "reply", "requester"] as const) {
      await expect(
        requireCustomer(customer.ctx, customer.opts, ticket, need),
      ).rejects.toEqual(notAccepted);
    }

    const agent = await gate(
      auth,
      await impersonatedHeaders(auth, w.agents.owner.user.email),
    );
    await expect(checkSession(agent.ctx, agent.opts, "agent")).rejects.toEqual(
      notAccepted,
    );
    for (const action of ACTIONS) {
      await expect(requireAgent(agent.ctx, agent.opts, action)).rejects.toEqual(
        notAccepted,
      );
    }
  });

  it("answers 401 without a session", async () => {
    const { ctx, opts } = await gate(auth);
    const unauthorized = error("UNAUTHORIZED");
    await expect(checkSession(ctx, opts, "customer")).rejects.toEqual(
      unauthorized,
    );
    await expect(requireAgent(ctx, opts, "read")).rejects.toEqual(unauthorized);
    await expect(requireCustomer(ctx, opts, null, "read")).rejects.toEqual(
      unauthorized,
    );
  });

  it("uses a custom acceptSession, with the session, headers and kind", async () => {
    const acceptSession = vi.fn(
      ({ kind }: { kind: "customer" | "agent" }) => kind === "customer",
    );
    const { auth, world: w } = await world({ acceptSession });
    const t = await insertTicket(auth, { userId: w.customer.user.id });
    // an impersonated session the app chose to accept
    const customer = await gate(
      auth,
      await impersonatedHeaders(auth, w.customer.user.email),
    );
    await expect(
      requireCustomer(customer.ctx, customer.opts, t, "read"),
    ).resolves.toMatchObject({ role: "requester" });
    expect(acceptSession).toHaveBeenLastCalledWith({
      session: customer.session,
      headers: customer.ctx.headers,
      kind: "customer",
    });

    const agent = await gate(auth, w.agents.owner.headers);
    await expect(requireAgent(agent.ctx, agent.opts, "read")).rejects.toEqual(
      notAccepted,
    );
    expect(acceptSession).toHaveBeenLastCalledWith({
      session: agent.session,
      headers: agent.ctx.headers,
      kind: "agent",
    });
  });
});

describe("default isAgent", () => {
  it("is a staff member whose role has support:read", async () => {
    const { auth, world: w } = await world();
    const { ctx, opts } = await gate(auth);
    const isAgent = (user: TestUser) => defaultIsAgent(ctx, opts, user.user.id);
    for (const role of [
      "owner",
      "admin",
      "member",
      "readOnly",
      "lacksReply",
      "lacksUpdate",
      "lacksManage",
      "lacksDelete",
    ] as const) {
      expect(await isAgent(w.agents[role]), role).toBe(true);
    }
    for (const role of ["billing", "lacksRead"] as const) {
      expect(await isAgent(w.agents[role]), role).toBe(false);
    }
    // customer-org owner (support:* in their own org), teammate, outsider
    expect(await isAgent(w.customer)).toBe(false);
    expect(await isAgent(w.teammate)).toBe(false);
    expect(await isAgent(w.outsider)).toBe(false);
    expect(await defaultIsAgent(ctx, opts, "user_missing")).toBe(false);
  });
});

describe("requireCustomer (read rule, teammate rights)", () => {
  it("lets the requester do everything and hides others' private tickets", async () => {
    const { auth, world: w } = await world();
    const own = await insertTicket(auth, { userId: w.customer.user.id });
    const inOrg = await insertTicket(auth, {
      userId: w.customer.user.id,
      organizationId: w.customerOrg.id,
    });
    const customer = await gate(auth, w.customer.headers);
    for (const t of [own, inOrg]) {
      for (const need of ["read", "reply", "requester"] as const) {
        const result = await requireCustomer(
          customer.ctx,
          customer.opts,
          t,
          need,
        );
        expect(result.role).toBe("requester");
        expect(result.ticket).toBe(t);
        expect(result.session).toEqual(customer.session);
      }
    }
    // private, even inside the org: teammates and outsiders get 404, never 403
    for (const user of [w.teammate, w.outsider, w.agents.owner]) {
      const g = await gate(auth, user.headers);
      for (const t of [own, inOrg]) {
        for (const need of ["read", "reply", "requester"] as const) {
          await expect(requireCustomer(g.ctx, g.opts, t, need)).rejects.toEqual(
            notFound,
          );
        }
      }
    }
    await expect(
      requireCustomer(customer.ctx, customer.opts, null, "read"),
    ).rejects.toEqual(notFound);
  });

  it("lets a teammate read and reply on a shared ticket, but not act as requester", async () => {
    const { auth, world: w } = await world();
    const shared = await insertTicket(auth, {
      userId: w.customer.user.id,
      organizationId: w.customerOrg.id,
      visibility: "organization",
    });
    const teammate = await gate(auth, w.teammate.headers);
    for (const need of ["read", "reply"] as const) {
      const result = await requireCustomer(
        teammate.ctx,
        teammate.opts,
        shared,
        need,
      );
      expect(result.role).toBe("teammate");
    }
    await expect(
      requireCustomer(teammate.ctx, teammate.opts, shared, "requester"),
    ).rejects.toEqual(notAllowed);

    // a non-member (outsider, staff) never sees it
    for (const user of [w.outsider, w.agents.owner]) {
      const g = await gate(auth, user.headers);
      await expect(
        requireCustomer(g.ctx, g.opts, shared, "read"),
      ).rejects.toEqual(notFound);
    }
    // "organization" with no organization id is visible to its requester only
    const orphan = await insertTicket(auth, {
      userId: w.customer.user.id,
      visibility: "organization",
    });
    await expect(
      requireCustomer(teammate.ctx, teammate.opts, orphan, "read"),
    ).rejects.toEqual(notFound);
  });

  it("ends a removed teammate's shared access at once; a removed requester keeps their own", async () => {
    const { auth, world: w } = await world();
    const byCustomer = await insertTicket(auth, {
      userId: w.customer.user.id,
      organizationId: w.customerOrg.id,
      visibility: "organization",
    });
    const byTeammate = await insertTicket(auth, {
      userId: w.teammate.user.id,
      organizationId: w.customerOrg.id,
      visibility: "organization",
    });
    const teammate = await gate(auth, w.teammate.headers);
    await expect(
      requireCustomer(teammate.ctx, teammate.opts, byCustomer, "read"),
    ).resolves.toMatchObject({ role: "teammate" });

    await removeMember(auth, {
      organizationId: w.customerOrg.id,
      member: w.teammate,
      by: w.customer,
    });

    // the removed teammate loses the shared ticket
    for (const need of ["read", "reply", "requester"] as const) {
      await expect(
        requireCustomer(teammate.ctx, teammate.opts, byCustomer, need),
      ).rejects.toEqual(notFound);
    }
    // ...and keeps the one they filed, with every requester right
    for (const need of ["read", "reply", "requester"] as const) {
      await expect(
        requireCustomer(teammate.ctx, teammate.opts, byTeammate, need),
      ).resolves.toMatchObject({ role: "requester" });
    }
    // the remaining member still sees it as a teammate
    const customer = await gate(auth, w.customer.headers);
    await expect(
      requireCustomer(customer.ctx, customer.opts, byTeammate, "reply"),
    ).resolves.toMatchObject({ role: "teammate" });
  });
});

describe("myOrganizationIds", () => {
  it("lists the caller's current organizations", async () => {
    const { auth, world: w } = await world();
    const { adapter } = await gate(auth);
    expect(await myOrganizationIds(adapter, w.customer.user.id)).toEqual([
      w.customerOrg.id,
    ]);
    expect(await myOrganizationIds(adapter, w.agents.owner.user.id)).toEqual([
      STAFF_ORG_ID,
    ]);
    expect(await myOrganizationIds(adapter, w.outsider.user.id)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------

const t0 = new Date("2026-01-01T00:00:00.000Z");
const t1 = new Date("2026-01-02T00:00:00.000Z");
const t2 = new Date("2026-01-03T00:00:00.000Z");

// every column set, hidden ones included, so a leak shows up as a key
const fullTicket = (
  overrides: Partial<SupportTicketRow> = {},
): SupportTicketRow => ({
  id: "t_1",
  number: 7,
  subject: "Printer on fire",
  status: "pending",
  priority: "high",
  channel: "email",
  userId: "u_req",
  requesterEmail: "stored@acme.test",
  requesterName: "Stored Name",
  organizationId: "org_acme",
  visibility: "organization",
  assigneeId: "u_agent",
  rating: "good",
  verified: false,
  mergedIntoId: "t_0",
  replyToken: "abcdefghijklmnopqrstuvwxyz",
  requesterSeenAt: t0,
  agentSeenAt: t2,
  lastMessageAt: t1,
  solvedAt: t2,
  createdAt: t0,
  updatedAt: t1,
  ...overrides,
});

const fullMessage = (
  overrides: Partial<SupportMessageRow> = {},
): SupportMessageRow => ({
  id: "m_1",
  ticketId: "t_1",
  kind: "reply",
  authorType: "agent",
  userId: "u_agent",
  authorEmail: "sender@acme.test",
  authorName: "Sender",
  body: "On it",
  data: null,
  mentions: ["u_other"],
  emailMessageId: "<id@mail.test>",
  channel: "email",
  verified: true,
  createdAt: t1,
  ...overrides,
});

const summary = (id: string, name: string): UserSummary => ({
  id,
  name,
  email: `${id}@acme.test`,
  emailVerified: true,
  image: `https://img.test/${id}.png`,
});

const users = new Map<string, UserSummary>([
  ["u_req", summary("u_req", "Requester")],
  ["u_agent", summary("u_agent", "Agent Smith")],
]);

const CUSTOMER_TICKET_KEYS = [
  "channel",
  "createdAt",
  "id",
  "lastMessageAt",
  "number",
  "organizationId",
  "priority",
  "rating",
  "solvedAt",
  "status",
  "subject",
  "unread",
  "updatedAt",
  "visibility",
];

const CUSTOMER_MESSAGE_KEYS = [
  "author",
  "authorType",
  "body",
  "createdAt",
  "data",
  "id",
  "kind",
  "ticketId",
];

const HIDDEN_FROM_CUSTOMERS = [
  "replyToken",
  "assigneeId",
  "agentSeenAt",
  "requesterSeenAt",
  "mentions",
  "verified",
  "emailMessageId",
  "userId",
  "requesterEmail",
  "requesterName",
  "authorEmail",
  "authorName",
  "mergedIntoId",
];

const AGENT_TICKET_KEYS = [
  "agentSeenAt",
  "assignee",
  "assigneeId",
  "channel",
  "createdAt",
  "id",
  "lastMessageAt",
  "mergedIntoId",
  "number",
  "organizationId",
  "priority",
  "rating",
  "requester",
  "requesterSeenAt",
  "solvedAt",
  "status",
  "subject",
  "tags",
  "unread",
  "updatedAt",
  "userId",
  "verified",
  "visibility",
];

const AGENT_MESSAGE_KEYS = [
  "author",
  "authorType",
  "body",
  "channel",
  "createdAt",
  "data",
  "emailMessageId",
  "id",
  "kind",
  "mentions",
  "ticketId",
  "userId",
  "verified",
];

const keys = (value: object) => Object.keys(value).sort();
const deepKeys = (value: unknown): string[] =>
  value && typeof value === "object" && !(value instanceof Date)
    ? Object.entries(value).flatMap(([k, v]) => [k, ...deepKeys(v)])
    : [];

describe("customer serializer", () => {
  it("returns exactly the customer ticket fields", () => {
    const view = toCustomerTicket(fullTicket(), "u_req");
    expect(keys(view)).toEqual(CUSTOMER_TICKET_KEYS);
    for (const hidden of HIDDEN_FROM_CUSTOMERS) {
      expect(deepKeys(view)).not.toContain(hidden);
    }
    expect(JSON.stringify(view)).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(view).toEqual({
      id: "t_1",
      number: 7,
      subject: "Printer on fire",
      status: "pending",
      priority: "high",
      channel: "email",
      organizationId: "org_acme",
      visibility: "organization",
      rating: "good",
      createdAt: t0,
      updatedAt: t1,
      lastMessageAt: t1,
      solvedAt: t2,
      unread: true,
    });
  });

  it("is unread only for the requester with an older or missing seen mark", () => {
    expect(toCustomerTicket(fullTicket(), "u_req").unread).toBe(true);
    expect(
      toCustomerTicket(fullTicket({ requesterSeenAt: null }), "u_req").unread,
    ).toBe(true);
    expect(
      toCustomerTicket(fullTicket({ requesterSeenAt: t1 }), "u_req").unread,
    ).toBe(false);
    expect(
      toCustomerTicket(fullTicket({ requesterSeenAt: t2 }), "u_req").unread,
    ).toBe(false);
    // teammates never get unread
    expect(toCustomerTicket(fullTicket(), "u_teammate").unread).toBe(false);
    expect(
      toCustomerTicket(fullTicket({ userId: null }), "u_teammate").unread,
    ).toBe(false);
  });

  it("fills missing optional fields with null", () => {
    const view = toCustomerTicket(
      fullTicket({
        priority: undefined,
        organizationId: undefined,
        rating: null,
        solvedAt: undefined,
      }),
      "u_req",
    );
    expect(keys(view)).toEqual(CUSTOMER_TICKET_KEYS);
    expect(view).toMatchObject({
      priority: null,
      organizationId: null,
      rating: null,
      solvedAt: null,
    });
  });

  it("returns replies with a public author only, and no hidden message fields", () => {
    const agentReply = toCustomerMessage(fullMessage(), users);
    expect(agentReply).not.toBeNull();
    expect(keys(agentReply as object)).toEqual(CUSTOMER_MESSAGE_KEYS);
    expect(agentReply).toEqual({
      id: "m_1",
      ticketId: "t_1",
      kind: "reply",
      authorType: "agent",
      author: { name: "Agent Smith", image: "https://img.test/u_agent.png" },
      body: "On it",
      data: null,
      createdAt: t1,
    });
    for (const hidden of HIDDEN_FROM_CUSTOMERS) {
      expect(deepKeys(agentReply)).not.toContain(hidden);
    }
    expect(keys((agentReply as { author: object }).author)).toEqual([
      "image",
      "name",
    ]);

    // an account-less sender shows their name, never their address
    const emailReply = toCustomerMessage(
      fullMessage({
        authorType: "customer",
        userId: null,
        authorEmail: "anon@acme.test",
        authorName: "Anon",
      }),
      users,
    );
    expect(emailReply?.author).toEqual({ name: "Anon", image: null });
    expect(JSON.stringify(emailReply)).not.toContain("anon@acme.test");

    // a reply row never carries data
    expect(
      toCustomerMessage(fullMessage({ data: { type: "status" } }), users)?.data,
    ).toBeNull();
  });

  it("hides notes and every event except status and merged", () => {
    expect(toCustomerMessage(fullMessage({ kind: "note" }), users)).toBeNull();
    for (const type of [
      "assignee",
      "priority",
      "attachment_dropped",
      "followup_of",
    ] as const) {
      expect(
        toCustomerMessage(
          fullMessage({ kind: "event", data: { type, from: "a", to: "b" } }),
          users,
        ),
      ).toBeNull();
    }
    expect(
      toCustomerMessage(fullMessage({ kind: "event", data: null }), users),
    ).toBeNull();

    const status = toCustomerMessage(
      fullMessage({
        kind: "event",
        authorType: "system",
        userId: null,
        body: "",
        data: { type: "status", from: "open", to: "solved" },
      }),
      users,
    );
    expect(keys(status as object)).toEqual(CUSTOMER_MESSAGE_KEYS);
    expect(status).toMatchObject({
      kind: "event",
      author: null,
      data: { type: "status", from: "open", to: "solved" },
    });
    const merged = toCustomerMessage(
      fullMessage({ kind: "event", data: { type: "merged", to: "t_9" } }),
      users,
    );
    expect(merged?.data).toEqual({ type: "merged", to: "t_9" });
  });
});

describe("agent serializer", () => {
  it("returns every agent ticket field and never replyToken", () => {
    const view = toAgentTicket(fullTicket(), { users, tags: ["billing"] });
    expect(keys(view)).toEqual(AGENT_TICKET_KEYS);
    expect(deepKeys(view)).not.toContain("replyToken");
    expect(JSON.stringify(view)).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(view).toMatchObject({
      userId: "u_req",
      requester: {
        id: "u_req",
        name: "Requester",
        email: "u_req@acme.test",
        image: "https://img.test/u_req.png",
      },
      assigneeId: "u_agent",
      assignee: {
        id: "u_agent",
        name: "Agent Smith",
        image: "https://img.test/u_agent.png",
      },
      verified: false,
      mergedIntoId: "t_0",
      tags: ["billing"],
      // agentSeenAt (t2) is newer than lastMessageAt (t1)
      unread: false,
    });
    expect(keys(view.requester)).toEqual(["email", "id", "image", "name"]);
    expect(keys(view.assignee as object)).toEqual(["id", "image", "name"]);
  });

  it("shows an account-less requester from the stored fields, and agent unread", () => {
    const view = toAgentTicket(
      fullTicket({ userId: null, assigneeId: null, agentSeenAt: null }),
      { users, tags: [] },
    );
    expect(view.requester).toEqual({
      id: null,
      name: "Stored Name",
      email: "stored@acme.test",
      image: null,
    });
    expect(view.assignee).toBeNull();
    expect(view.unread).toBe(true);
    expect(
      toAgentTicket(fullTicket({ agentSeenAt: t0 }), { users, tags: [] })
        .unread,
    ).toBe(true);
  });

  it("returns every message kind with mentions and verification", () => {
    const note = toAgentMessage(fullMessage({ kind: "note" }), users);
    expect(keys(note)).toEqual(AGENT_MESSAGE_KEYS);
    expect(note).toMatchObject({
      kind: "note",
      userId: "u_agent",
      author: {
        id: "u_agent",
        name: "Agent Smith",
        email: "u_agent@acme.test",
        image: "https://img.test/u_agent.png",
      },
      mentions: ["u_other"],
      verified: true,
      emailMessageId: "<id@mail.test>",
      channel: "email",
    });
    const anon = toAgentMessage(
      fullMessage({
        authorType: "customer",
        userId: null,
        mentions: null,
        emailMessageId: null,
      }),
      users,
    );
    expect(anon.author).toEqual({
      id: null,
      name: "Sender",
      email: "sender@acme.test",
      image: null,
    });
    expect(anon.mentions).toEqual([]);
    expect(anon.emailMessageId).toBeNull();
    const event = toAgentMessage(
      fullMessage({
        kind: "event",
        authorType: "system",
        userId: null,
        authorEmail: null,
        authorName: null,
        data: { type: "assignee", from: null, to: "u_agent" },
      }),
      users,
    );
    expect(event.author).toBeNull();
    expect(event.data).toEqual({ type: "assignee", from: null, to: "u_agent" });
  });
});
