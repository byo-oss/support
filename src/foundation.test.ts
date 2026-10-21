import { runWithTransaction } from "@better-auth/core/context";
import { getAuthTables } from "@better-auth/core/db";
import { memoryMailer } from "@byo-oss/mailer";
import { betterAuth } from "better-auth";
import { describe, expect, it, vi } from "vitest";
import {
  authRuntime,
  chunk,
  findManyIn,
  findMember,
  IN_CHUNK,
  listMemberships,
  lowerEmail,
  markSupportQuery,
} from "./adapter";
import { supportPathMethods } from "./client";
import { allocateTicketNumber } from "./counter";
import { SUPPORT_ERROR_CODES } from "./error-codes";
import { emit, SUPPORT_EVENT_TYPES, ticketEvent } from "./events";
import { support } from "./index";
import {
  MERGE_AVAILABLE,
  resolveOptions,
  type SupportStorage,
} from "./options";
import { buildSchema, fullSchema } from "./schema";
import { supportRoles, supportStatements } from "./statements";
import type { SqlTestAuth } from "./test-sql";
import {
  addMember,
  baseAuthOptions,
  createOrganization,
  createTestAuth,
  getContext,
  impersonatedHeaders,
  insertMessage,
  insertTag,
  insertTicket,
  removeMember,
  STAFF_ORG_ID,
  STAFF_ORG_UUID,
  seedSupportWorld,
  signUpUser,
  staffOrgIdFor,
  takeStrictViolations,
  testRoles,
} from "./test-utils";
import { createReplyToken, isReplyToken, REPLY_TOKEN_LENGTH } from "./token";

const storage: SupportStorage = {
  put: async () => {},
  get: async () => null,
  delete: async () => {},
  deletePrefix: async () => {},
};
const email = {
  from: "Support <support@acme.test>",
  replyDomain: "reply.acme.test",
  appUrl: "https://app.acme.test",
};
const inboundSource = { receive: async () => ({ reject: 401 }) };

const CORE_MODELS = [
  "supportTicket",
  "supportCounter",
  "supportTicketTag",
  "supportMessage",
  "supportCannedReply",
];

describe("schema", () => {
  it("declares the optional tables only with their feature on", () => {
    expect(Object.keys(buildSchema({}))).toEqual(CORE_MODELS);
    expect(Object.keys(buildSchema({ mailer: memoryMailer() }))).toEqual([
      ...CORE_MODELS,
      "supportDelivery",
    ]);
    expect(Object.keys(buildSchema({ attachments: { storage } }))).toEqual([
      ...CORE_MODELS,
      "supportAttachment",
    ]);
    expect(
      Object.keys(
        support({ mailer: memoryMailer(), email, attachments: { storage } })
          .schema,
      ),
    ).toEqual([...CORE_MODELS, "supportDelivery", "supportAttachment"]);
  });

  it("reaches better-auth's tables only with the feature on", () => {
    const tables = (plugin: ReturnType<typeof support>) =>
      Object.keys(getAuthTables({ plugins: [plugin] })).filter((t) =>
        t.startsWith("support"),
      );
    expect(tables(support())).toEqual(CORE_MODELS);
    expect(tables(support({ mailer: memoryMailer(), email }))).toContain(
      "supportDelivery",
    );
    expect(tables(support({ mailer: memoryMailer(), email }))).not.toContain(
      "supportAttachment",
    );
    expect(tables(support({ attachments: { storage } }))).toContain(
      "supportAttachment",
    );
    expect(tables(support({ attachments: { storage } }))).not.toContain(
      "supportDelivery",
    );
  });

  it("declares onDelete explicitly on every reference", () => {
    const references: Record<string, string> = {};
    for (const [model, { fields }] of Object.entries(fullSchema)) {
      for (const [field, attr] of Object.entries(fields)) {
        if (!("references" in attr)) continue;
        const ref = attr.references as { model: string; onDelete?: string };
        expect(ref.onDelete, `${model}.${field}`).toBeDefined();
        references[`${model}.${field}`] = `${ref.model}:${ref.onDelete}`;
      }
    }
    expect(references).toEqual({
      "supportTicket.userId": "user:set null",
      "supportTicket.organizationId": "organization:cascade",
      "supportTicket.assigneeId": "user:set null",
      "supportTicket.mergedIntoId": "supportTicket:set null",
      "supportTicketTag.ticketId": "supportTicket:cascade",
      "supportMessage.ticketId": "supportTicket:cascade",
      "supportMessage.userId": "user:set null",
      "supportCannedReply.userId": "user:set null",
      "supportDelivery.messageId": "supportMessage:cascade",
      "supportDelivery.ticketId": "supportTicket:cascade",
      "supportAttachment.ticketId": "supportTicket:cascade",
      "supportAttachment.messageId": "supportMessage:cascade",
      "supportAttachment.userId": "user:set null",
    });
  });

  it("flags the indexed and unique fields", () => {
    const flagged = (flag: "index" | "unique") =>
      Object.entries(fullSchema)
        .flatMap(([model, { fields }]) =>
          Object.entries(fields)
            .filter(
              ([, attr]) => (attr as Record<string, unknown>)[flag] === true,
            )
            .map(([field]) => `${model}.${field}`),
        )
        .sort();
    expect(flagged("unique")).toEqual(
      [
        "supportCounter.key",
        "supportMessage.emailMessageId",
        "supportTicket.number",
        "supportTicket.replyToken",
      ].sort(),
    );
    expect(flagged("index")).toEqual(
      [
        // PRD list
        "supportTicket.organizationId",
        "supportTicket.userId",
        "supportTicket.assigneeId",
        "supportTicket.status",
        "supportTicket.lastMessageAt",
        "supportTicket.requesterEmail",
        "supportTicketTag.ticketId",
        "supportTicketTag.tag",
        "supportMessage.ticketId",
        "supportMessage.userId",
        "supportMessage.authorEmail",
        "supportMessage.createdAt",
        "supportCannedReply.userId",
        "supportDelivery.ticketId",
        "supportDelivery.status",
        "supportDelivery.scheduledFor",
        "supportAttachment.ticketId",
        "supportAttachment.userId",
        // filtered by delete, merge and prune paths (contracts.md)
        "supportTicket.mergedIntoId",
        "supportDelivery.messageId",
        "supportAttachment.messageId",
        "supportAttachment.createdAt",
      ].sort(),
    );
  });

  it("lets the app rename tables through options.schema", () => {
    const plugin = support({
      schema: { supportTicket: { modelName: "help_ticket" } },
    });
    expect(
      (plugin.schema.supportTicket as { modelName?: string }).modelName,
    ).toBe("help_ticket");
  });
});

describe("options", () => {
  const boot = (options: Parameters<typeof support>[0]) => () =>
    support(options);

  it("refuses mailer without email, and email without mailer", () => {
    expect(boot({ mailer: memoryMailer() })).toThrow(
      /^\[@byo-oss\/support\] mailer needs email/,
    );
    expect(boot({ email })).toThrow(
      /^\[@byo-oss\/support\] email needs mailer/,
    );
  });

  it("refuses inbound without email", () => {
    expect(boot({ inbound: { source: inboundSource } })).toThrow(
      /^\[@byo-oss\/support\] inbound needs email/,
    );
  });

  it("refuses inbound without source", () => {
    expect(
      boot({ mailer: memoryMailer(), email, inbound: {} as never }),
    ).toThrow(/^\[@byo-oss\/support\] inbound needs source/);
  });

  it("refuses a replyDomain that is an address", () => {
    expect(
      boot({
        mailer: memoryMailer(),
        email: { ...email, replyDomain: "support@reply.acme.test" },
      }),
    ).toThrow(
      /^\[@byo-oss\/support\] email.replyDomain is a domain, not an address/,
    );
  });

  it.each([
    ["pageSize", () => ({ pageSize: 1.5 }), 1],
    ["pageSize", () => ({ pageSize: 0 }), 1],
    ["autoCloseAfter", () => ({ autoCloseAfter: -1 }), 0],
    ["autoCloseAfter", () => ({ autoCloseAfter: 0.5 }), 0],
    ["maxAttempts", () => ({ maxAttempts: 0 }), 1],
    ["maxAttempts", () => ({ maxAttempts: 2.5 }), 1],
    ["batchSize", () => ({ batchSize: 0 }), 1],
    ["batchSize", () => ({ batchSize: Number.NaN }), 1],
    ["leaseMs", () => ({ leaseMs: 0 }), 1],
    ["leaseMs", () => ({ leaseMs: 1.5 }), 1],
    [
      "inbound.maxPerSenderPerHour",
      () => ({ inbound: { source: inboundSource, maxPerSenderPerHour: -1 } }),
      0,
    ],
    [
      "inbound.maxUnverifiedPerHour",
      () => ({
        inbound: { source: inboundSource, maxUnverifiedPerHour: 1.5 },
      }),
      0,
    ],
    [
      "inbound.maxBytes",
      () => ({ inbound: { source: inboundSource, maxBytes: 0 } }),
      1,
    ],
    [
      "attachments.maxBytes",
      () => ({ attachments: { storage, maxBytes: 0 } }),
      1,
    ],
    [
      "attachments.maxBytes",
      () => ({ attachments: { storage, maxBytes: 1.5 } }),
      1,
    ],
  ])("refuses a bad %s", (name, make, min) => {
    expect(boot({ mailer: memoryMailer(), email, ...make() } as never)).toThrow(
      new RegExp(
        `^\\[@byo-oss/support\\] ${name.replace(".", "\\.")} must be an integer of at least ${min}`,
      ),
    );
  });

  it("accepts zero where zero is allowed", () => {
    expect(
      boot({
        mailer: memoryMailer(),
        email,
        autoCloseAfter: 0,
        inbound: {
          source: inboundSource,
          maxPerSenderPerHour: 0,
          maxUnverifiedPerHour: 0,
        },
      }),
    ).not.toThrow();
  });

  it("refuses attachments without storage", () => {
    expect(boot({ attachments: {} as never })).toThrow(
      /^\[@byo-oss\/support\] attachments needs storage/,
    );
  });

  it("refuses a negative replyDelay", () => {
    expect(
      boot({ mailer: memoryMailer(), email: { ...email, replyDelay: -1 } }),
    ).toThrow(/^\[@byo-oss\/support\] email.replyDelay must be 0 or more/);
    expect(
      boot({ mailer: memoryMailer(), email: { ...email, replyDelay: 0 } }),
    ).not.toThrow();
  });

  it.each([
    "text/html",
    "image/svg+xml",
    "application/xhtml+xml",
    "Text/HTML; charset=utf-8",
  ])("refuses %s in allowedTypes", (type) => {
    expect(
      boot({ attachments: { storage, allowedTypes: ["image/png", type] } }),
    ).toThrow(/^\[@byo-oss\/support\] attachments.allowedTypes can't include/);
  });

  it("refuses a pageSize above 50", () => {
    expect(boot({ pageSize: 51 })).toThrow(
      /^\[@byo-oss\/support\] pageSize can be at most 50/,
    );
  });

  it("fills defaults and features", () => {
    const opts = resolveOptions({});
    expect(opts).toMatchObject({
      organizationCleanup: true,
      autoCloseAfter: 7 * 24 * 60 * 60_000,
      maxAttempts: 5,
      batchSize: 100,
      leaseMs: 300_000,
      pageSize: 25,
      uploadTtlMs: 24 * 60 * 60_000,
      features: { attachments: false, merge: MERGE_AVAILABLE },
    });
    expect(opts.email).toBeUndefined();
    const full = resolveOptions({
      mailer: memoryMailer(),
      email: {
        ...email,
        appUrl: "https://app.acme.test/",
        replyDomain: "Reply.Acme.Test",
      },
      inbound: { source: inboundSource },
      attachments: { storage },
    });
    expect(full.email).toMatchObject({
      appUrl: "https://app.acme.test",
      replyDomain: "reply.acme.test",
      replyDelay: 120_000,
      requireVerifiedEmail: true,
    });
    expect(full.email?.ticketPath("t1")).toBe("/support/t1");
    expect(full.inbound).toMatchObject({
      newTickets: true,
      maxPerSenderPerHour: 20,
      maxUnverifiedPerHour: 100,
      maxBytes: 26_214_400,
    });
    expect(full.attachments?.maxBytes).toBe(10_485_760);
    expect(full.attachments?.allowedTypes).toContain("application/pdf");
    expect(full.features.attachments).toBe(true);
  });

  it("refuses impersonated sessions by default", async () => {
    const opts = resolveOptions({});
    const session = (impersonatedBy: string | null) =>
      ({ user: {}, session: { impersonatedBy } }) as never;
    const headers = new Headers();
    expect(
      await opts.acceptSession({
        session: session(null),
        headers,
        kind: "customer",
      }),
    ).toBe(true);
    expect(
      await opts.acceptSession({
        session: session("admin"),
        headers,
        kind: "agent",
      }),
    ).toBe(false);
  });

  it("throws ORGANIZATION_PLUGIN_REQUIRED in init without the organization plugin", async () => {
    const auth = createTestAuth({}, { organization: false });
    await expect(auth.$context).rejects.toThrow(
      `[@byo-oss/support] ${SUPPORT_ERROR_CODES.ORGANIZATION_PLUGIN_REQUIRED.code}`,
    );
  });

  it("warns once when agent endpoints can only deny", async () => {
    const warnings: string[] = [];
    const logger = {
      level: "warn" as const,
      log: (level: string, message: string) => {
        if (level === "warn") warnings.push(message);
      },
    };
    await getContext(createTestAuth({}, { authOptions: { logger } }));
    expect(
      warnings.filter((w) => w.includes("every agent endpoint will deny")),
    ).toHaveLength(1);
    warnings.length = 0;
    await getContext(
      createTestAuth(
        { staffOrganizationId: "org_staff" },
        { authOptions: { logger } },
      ),
    );
    expect(
      warnings.filter((w) => w.includes("every agent endpoint will deny")),
    ).toHaveLength(0);
  });
});

describe("plugin shape", () => {
  it("registers id, error codes, statements and hooks", () => {
    const plugin = support();
    expect(plugin.id).toBe("support");
    expect(plugin.$ERROR_CODES).toBe(SUPPORT_ERROR_CODES);
    expect(Object.keys(SUPPORT_ERROR_CODES).sort()).toEqual(
      [
        "ORGANIZATION_PLUGIN_REQUIRED",
        "TICKET_NOT_FOUND",
        "NOT_ALLOWED",
        "SESSION_NOT_ACCEPTED",
        "NOT_A_MEMBER",
        "TICKET_CLOSED",
        "INBOUND_NOT_CONFIGURED",
        "MERGE_NOT_ALLOWED",
        "STORAGE_NOT_CONFIGURED",
        "ATTACHMENT_TOO_LARGE",
        "ATTACHMENT_TYPE_NOT_ALLOWED",
        "ATTACHMENT_NOT_USABLE",
        "NOT_AN_AGENT",
        "INVALID_STATUS_TRANSITION",
        "INVALID_CURSOR",
        "INVALID_TAG",
        "CANNED_REPLY_NOT_FOUND",
        "ATTACHMENT_NOT_FOUND",
      ].sort(),
    );
    expect(supportStatements).toEqual({
      support: ["read", "reply", "update", "manage", "delete"],
    });
    expect(supportRoles.member.support).toEqual(["read", "reply", "update"]);
    expect(plugin.hooks.after.length).toBeGreaterThan(0);
    expect(typeof plugin.byo.sweep).toBe("function");
  });

  it("returns the user create, update and delete hooks from init", async () => {
    const context = await getContext(createTestAuth());
    const result = await support().init(context);
    const user = result?.options?.databaseHooks?.user;
    expect(typeof user?.create?.after).toBe("function");
    expect(typeof user?.update?.after).toBe("function");
    expect(typeof user?.delete?.after).toBe("function");
  });

  it("lists every client-called path in pathMethods, and nothing server-only", () => {
    expect(supportPathMethods).toEqual({
      "/support/create-ticket": "POST",
      "/support/my-tickets": "GET",
      "/support/ticket": "GET",
      "/support/reply": "POST",
      "/support/update-mine": "POST",
      "/support/mark-seen": "POST",
      "/support/upload": "POST",
      "/support/attachment": "GET",
      "/support/agent/tickets": "GET",
      "/support/agent/ticket": "GET",
      "/support/agent/reply": "POST",
      "/support/agent/update": "POST",
      "/support/agent/merge": "POST",
      "/support/agent/delete": "POST",
      "/support/agent/mark-seen": "POST",
      "/support/agent/tags": "GET",
      "/support/agent/canned": "GET",
      "/support/agent/canned/save": "POST",
      "/support/agent/canned/delete": "POST",
      "/support/agent/upload": "POST",
      "/support/agent/attachment": "GET",
    });
  });
});

describe("reply token", () => {
  it("is 26 lowercase base32 characters from 16 random bytes", () => {
    const spy = vi.spyOn(globalThis.crypto, "getRandomValues");
    const token = createReplyToken();
    expect(spy).toHaveBeenCalledTimes(1);
    const bytes = spy.mock.calls[0]?.[0] as Uint8Array;
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(16);
    spy.mockRestore();
    expect(token).toHaveLength(REPLY_TOKEN_LENGTH);
    expect(token).toMatch(/^[a-z2-7]{26}$/);
    expect(isReplyToken(token)).toBe(true);
  });

  it("encodes the bytes it was given", () => {
    const spy = vi
      .spyOn(globalThis.crypto, "getRandomValues")
      .mockImplementation((array) => {
        (array as Uint8Array).fill(0);
        return array;
      });
    expect(createReplyToken()).toBe("a".repeat(26));
    spy.mockImplementation((array) => {
      (array as Uint8Array).fill(255);
      return array;
    });
    // 128 bits of ones: 25 full groups of five, then the last 3 bits padded
    expect(createReplyToken()).toBe(`${"7".repeat(25)}4`);
    spy.mockRestore();
  });

  it("is unique and rejects other shapes", () => {
    const tokens = new Set(Array.from({ length: 1000 }, createReplyToken));
    expect(tokens.size).toBe(1000);
    expect(isReplyToken("A".repeat(26))).toBe(false);
    expect(isReplyToken("a".repeat(25))).toBe(false);
    expect(isReplyToken("1".repeat(26))).toBe(false);
  });
});

describe("adapter helpers", () => {
  it("chunks at 90 and sends nothing for an empty list", () => {
    expect(chunk([])).toEqual([]);
    expect(
      chunk(Array.from({ length: 181 }, (_, i) => i)).map((c) => c.length),
    ).toEqual([90, 90, 1]);
    expect(IN_CHUNK).toBe(90);
    expect(lowerEmail("  Cora@Acme.TEST ")).toBe("cora@acme.test");
  });

  it("findManyIn pages through chunks without tripping the strict wrapper", async () => {
    const auth = createTestAuth();
    const { adapter } = await getContext(auth);
    const ids: string[] = [];
    for (let i = 0; i < 200; i++) {
      const user = await adapter.create<
        {
          email: string;
          name: string;
          emailVerified: boolean;
          createdAt: Date;
          updatedAt: Date;
        },
        { id: string }
      >({
        model: "user",
        data: {
          email: `u${i}@x.test`,
          name: `u${i}`,
          emailVerified: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
      ids.push(user.id);
    }
    expect(
      await findManyIn(adapter, { model: "user", field: "id", values: [] }),
    ).toEqual([]);
    const rows = await findManyIn<{ id: string }>(adapter, {
      model: "user",
      field: "id",
      values: [...ids, ...ids],
    });
    expect(rows.map((r) => r.id).sort()).toEqual([...ids].sort());
  });
});

describe("strict adapter wrapper", () => {
  it("rejects in [], a 91-value in and a findMany without limit on support models", async () => {
    const { adapter } = await getContext(createTestAuth());
    await expect(
      adapter.findMany({
        model: "supportTicket",
        where: [{ field: "id", operator: "in", value: [] }],
        limit: 10,
      }),
    ).rejects.toThrow(/strict adapter.*0 values/);
    const many = Array.from({ length: 91 }, (_, i) => `id${i}`);
    await expect(
      adapter.deleteMany({
        model: "supportMessage",
        where: [{ field: "id", operator: "in", value: many }],
      }),
    ).rejects.toThrow(/91 values/);
    await expect(adapter.findMany({ model: "supportTicket" })).rejects.toThrow(
      /without limit/,
    );
    await expect(
      adapter.count({
        model: "supportTicketTag",
        where: [{ field: "ticketId", operator: "not_in", value: [] }],
      }),
    ).rejects.toThrow(/strict adapter/);
    expect(takeStrictViolations()).toHaveLength(4);
  });

  it("accepts 90 values and a limited findMany", async () => {
    const { adapter } = await getContext(createTestAuth());
    const ninety = Array.from({ length: 90 }, (_, i) => `id${i}`);
    await expect(
      adapter.findMany({
        model: "supportTicket",
        where: [{ field: "id", operator: "in", value: ninety }],
        limit: 5,
      }),
    ).resolves.toEqual([]);
  });

  it("checks member/user reads made through support's helpers, not better-auth's own", async () => {
    const { adapter } = await getContext(createTestAuth());
    await expect(
      adapter.findMany({ model: "member", where: [] }),
    ).resolves.toEqual([]);
    await expect(
      adapter.findMany(markSupportQuery({ model: "member", where: [] })),
    ).rejects.toThrow(/without limit/);
    await expect(
      adapter.findOne(
        markSupportQuery({
          model: "user",
          where: [{ field: "id", operator: "in", value: [] }],
        }),
      ),
    ).rejects.toThrow(/0 values/);
    expect(takeStrictViolations()).toHaveLength(2);
    await expect(listMemberships(adapter, "nobody")).resolves.toEqual([]);
    await expect(
      findMember(adapter, { userId: "nobody", organizationId: "none" }),
    ).resolves.toBeNull();
  });

  it("wraps the transaction adapter too", async () => {
    const { adapter } = await getContext(createTestAuth());
    await expect(
      adapter.transaction((trx) => trx.findMany({ model: "supportTicket" })),
    ).rejects.toThrow(/without limit/);
    expect(takeStrictViolations()).toHaveLength(1);
  });

  it("lets an organization round trip through the org plugin pass", async () => {
    const auth = createTestAuth({ staffOrganizationId: "org_staff" });
    const owner = await signUpUser(auth, "owner@acme.test");
    const removed = await signUpUser(auth, "removed@acme.test");
    const leaver = await signUpUser(auth, "leaver@acme.test");
    const { adapter } = await getContext(auth);
    const members = (organizationId: string) =>
      adapter.findMany<{ userId: string }>({
        model: "member",
        where: [{ field: "organizationId", value: organizationId }],
        limit: 100,
      });

    const org = await createOrganization(auth, owner, {
      name: "Acme",
      slug: "acme",
    });
    await addMember(auth, {
      organizationId: org.id,
      userId: removed.user.id,
      role: "member",
    });
    await addMember(auth, {
      organizationId: org.id,
      userId: leaver.user.id,
      role: "member",
    });
    expect((await members(org.id)).map((m) => m.userId).sort()).toEqual(
      [owner.user.id, removed.user.id, leaver.user.id].sort(),
    );

    await removeMember(auth, {
      organizationId: org.id,
      member: removed,
      by: owner,
    });
    await auth.api.leaveOrganization({
      body: { organizationId: org.id },
      headers: leaver.headers,
    });
    expect((await members(org.id)).map((m) => m.userId)).toEqual([
      owner.user.id,
    ]);

    await auth.api.deleteOrganization({
      body: { organizationId: org.id },
      headers: owner.headers,
    });
    expect(await members(org.id)).toEqual([]);
    expect(
      await adapter.findOne({
        model: "organization",
        where: [{ field: "id", value: org.id }],
      }),
    ).toBeNull();
  });
});

describe("test harness", () => {
  it("seeds a staff org with one member per role, a customer org and an outsider", async () => {
    const auth = createTestAuth({ staffOrganizationId: STAFF_ORG_ID });
    const world = await seedSupportWorld(auth);
    const { adapter } = await getContext(auth);
    const staff = await adapter.findMany<{ userId: string; role: string }>({
      model: "member",
      where: [{ field: "organizationId", value: STAFF_ORG_ID }],
      limit: 100,
    });
    expect(staff).toHaveLength(Object.keys(testRoles).length);
    for (const [role, agent] of Object.entries(world.agents)) {
      expect(staff.find((m) => m.userId === agent.user.id)?.role).toBe(role);
      expect(agent.user.emailVerified).toBe(true);
    }
    const customers = await adapter.findMany<{ userId: string; role: string }>({
      model: "member",
      where: [{ field: "organizationId", value: world.customerOrg.id }],
      limit: 100,
    });
    expect(customers.map((m) => [m.userId, m.role]).sort()).toEqual(
      [
        [world.customer.user.id, "owner"],
        [world.teammate.user.id, "member"],
      ].sort(),
    );
    const session = await auth.api.getSession({
      headers: world.outsider.headers,
    });
    expect(session?.user.id).toBe(world.outsider.user.id);
  });

  it("marks a fresh session as impersonated, even with session options overridden", async () => {
    const auth = createTestAuth(
      {},
      { authOptions: { session: { expiresIn: 3600 } } },
    );
    const user = await signUpUser(auth, "imp@acme.test");
    const normal = await auth.api.getSession({ headers: user.headers });
    const impersonated = await auth.api.getSession({
      headers: await impersonatedHeaders(auth, "imp@acme.test"),
    });
    const by = (s: typeof normal) =>
      (s?.session as { impersonatedBy?: string | null } | undefined)
        ?.impersonatedBy ?? null;
    expect(by(normal)).toBeNull();
    expect(by(impersonated)).toBe("admin-user");
    expect(impersonated?.user.id).toBe(user.user.id);
  });
});

describe("staff org ids", () => {
  it("picks an id per id mode and refuses serial", () => {
    expect(staffOrgIdFor()).toBe(STAFF_ORG_ID);
    expect(staffOrgIdFor("uuid")).toBe(STAFF_ORG_UUID);
    expect(STAFF_ORG_UUID).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(() => staffOrgIdFor("serial")).toThrow(/serial/);
  });
});

describe("runtime and seeders", () => {
  it("authRuntime finds the resolved options, and refuses an auth without support", async () => {
    const auth = createTestAuth({
      staffOrganizationId: STAFF_ORG_ID,
      pageSize: 10,
    });
    const rt = await authRuntime(auth, "someFunction");
    expect(rt.opts.staffOrganizationId).toBe(STAFF_ORG_ID);
    expect(rt.opts.pageSize).toBe(10);
    expect(rt.adapter).toBe((await getContext(auth)).adapter);
    const plain = betterAuth({ ...baseAuthOptions });
    await expect(authRuntime(plain, "someFunction")).rejects.toThrow(
      "[@byo-oss/support] someFunction needs the support plugin installed on this auth instance",
    );
  });

  it("authRuntime joins a caller's transaction, on the wrapped transaction adapter", async () => {
    const auth = createTestAuth();
    const context = await getContext(auth);
    await runWithTransaction(context.adapter, async () => {
      const rt = await authRuntime(auth, "inside");
      expect(rt.adapter).not.toBe(context.adapter);
      await expect(
        rt.adapter.findMany({ model: "supportTicket" }),
      ).rejects.toThrow(/without limit/);
    });
    expect(takeStrictViolations()).toHaveLength(1);
  });

  it("inserts tickets, messages and tags with every required field", async () => {
    const auth = createTestAuth();
    const first = await insertTicket(auth);
    const second = await insertTicket(auth, {
      subject: "Billing",
      visibility: "organization",
    });
    expect([first.number, second.number]).toEqual([1, 2]);
    expect(second).toMatchObject({
      subject: "Billing",
      visibility: "organization",
      status: "open",
    });
    expect(second.replyToken).toMatch(/^[a-z2-7]{26}$/);
    const message = await insertMessage(auth, {
      ticketId: first.id,
      kind: "note",
      authorType: "agent",
    });
    expect(message).toMatchObject({
      ticketId: first.id,
      kind: "note",
      body: "Hello",
      verified: true,
    });
    const tag = await insertTag(auth, { ticketId: first.id, tag: "billing" });
    expect(tag).toMatchObject({ ticketId: first.id, tag: "billing" });
  });
});

describe("test auth types", () => {
  it("keeps auth.api precise on both lanes", async () => {
    const auth = createTestAuth();
    // @ts-expect-error no such endpoint: the api type is not an index signature
    auth.api.notARealEndpoint;
    const typed = async (sql: SqlTestAuth) => {
      // @ts-expect-error no such endpoint
      sql.api.notARealEndpoint;
      await sql.api.createOrganization({
        // @ts-expect-error the body is typed
        body: { nope: 1 },
        headers: new Headers(),
      });
    };
    expect(typeof typed).toBe("function");
    const owner = await signUpUser(auth, "typed@acme.test");
    const bad = auth.api.createOrganization({
      // @ts-expect-error the body is typed
      body: { nope: 1 },
      headers: owner.headers,
    });
    await expect(bad).rejects.toThrow();
    const org = await auth.api.createOrganization({
      body: { name: "Typed", slug: "typed" },
      headers: owner.headers,
    });
    const id: string = org.id;
    expect(id).toBeTruthy();
  });
});

describe("allocateTicketNumber (memory)", () => {
  it("counts from 1, creating the counter row on first use", async () => {
    const { adapter } = await getContext(createTestAuth());
    expect(await allocateTicketNumber(adapter)).toBe(1);
    expect(await allocateTicketNumber(adapter)).toBe(2);
    expect(await allocateTicketNumber(adapter)).toBe(3);
    const rows = await adapter.findMany<{ key: string; value: number }>({
      model: "supportCounter",
      limit: 10,
    });
    expect(rows).toEqual([
      expect.objectContaining({ key: "ticket", value: 3 }),
    ]);
  });

  it("retries the increment once when the create loses a race", async () => {
    let raced = false;
    let increments = 0;
    let winner: (() => Promise<unknown>) | undefined;
    const auth = createTestAuth(
      {},
      {
        adapter: {
          before: async ({ method, model }) => {
            if (model !== "supportCounter") return;
            if (method === "incrementOne") increments++;
            if (method === "create" && !raced && winner) {
              // another request creates the row first; this create then fails
              raced = true;
              await winner();
              throw new Error("duplicate key value violates unique constraint");
            }
          },
        },
      },
    );
    const { adapter } = await getContext(auth);
    winner = () =>
      adapter.create({
        model: "supportCounter",
        data: { key: "ticket", value: 1 },
      });
    expect(await allocateTicketNumber(adapter)).toBe(2);
    expect(raced).toBe(true);
    expect(increments).toBe(2);
  });
});

describe("events", () => {
  it("defines the eight event types", () => {
    expect(SUPPORT_EVENT_TYPES).toHaveLength(8);
    for (const type of SUPPORT_EVENT_TYPES)
      expect(type).toMatch(/^support\.[a-z]+\.[a-z_]+$/);
  });

  it("builds ticket events and never throws from onEvent", async () => {
    const event = ticketEvent(
      "support.ticket.created",
      { id: "t1", organizationId: "o1", visibility: "private" },
      {
        actorId: "u1",
        userId: "u1",
        data: { ticketId: "t1" },
      },
    );
    expect(event).toMatchObject({
      type: "support.ticket.created",
      subject: { type: "supportTicket", id: "t1" },
      organizationId: "o1",
      userId: "u1",
      actorId: "u1",
    });
    // every event says whether the ticket is private, for org fan-out
    expect(event.data).toEqual({ ticketId: "t1", visibility: "private" });
    expect(
      ticketEvent(
        "support.ticket.status_changed",
        { id: "t2", organizationId: "o1", visibility: "organization" },
        { actorId: null, data: { ticketId: "t2", from: "open", to: "solved" } },
      ).data,
    ).toEqual({
      ticketId: "t2",
      from: "open",
      to: "solved",
      visibility: "organization",
    });
    const errors: unknown[] = [];
    await expect(
      emit({ onEvent: () => Promise.reject(new Error("boom")) }, event, {
        error: (...a) => errors.push(a),
      }),
    ).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    const seen: unknown[] = [];
    await emit({ onEvent: (e) => void seen.push(e) }, event);
    expect(seen).toEqual([event]);
    await expect(emit({}, event)).resolves.toBeUndefined();
  });
});

describe("betterAuth without test helpers", () => {
  it("boots with organization and support on the default memory adapter", async () => {
    const { organization } = await import("better-auth/plugins/organization");
    const auth = betterAuth({
      ...baseAuthOptions,
      plugins: [organization(), support()],
    });
    await expect(auth.$context).resolves.toBeTruthy();
  });
});
