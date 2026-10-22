// PRD acceptance #16 (J10): every event support emits matches core's
// `ByoEvent`, carries no message bodies, never fails a request, and reaches
// an app's `@byo-oss/notifications` inbox through `createEventBus`.

import { runWithTransaction } from "@better-auth/core/context";
import { getAuthTables } from "@better-auth/core/db";
import { type MemoryDB, memoryAdapter } from "@better-auth/memory-adapter";
import {
  type ByoEvent,
  type ByoEventHandler,
  createEventBus,
  sweepAll,
} from "@byo-oss/core";
import { inbox } from "@byo-oss/notifications";
import { betterAuth } from "better-auth";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { authRuntime, type SupportRuntime } from "./adapter";
import {
  emit,
  SUPPORT_EVENT_TYPES,
  type SupportEvent,
  type SupportEventType,
} from "./events";
import { type SupportOptions, support } from "./index";
import {
  createTestAuth,
  getContext,
  insertTicket,
  mergeAuthOptions,
  STAFF_ORG_ID,
  seedSupportWorld,
  type TestAuth,
  testOrganization,
  wrapAdapterFactory,
} from "./test-utils";

// ---------------------------------------------------------------------------
// Type level: a support event is a ByoEvent
// ---------------------------------------------------------------------------

describe("event types (type level)", () => {
  it("a SupportEvent assigns to core's ByoEvent, and every type matches its template", () => {
    expectTypeOf<SupportEvent>().toExtend<ByoEvent>();
    expectTypeOf<SupportEventType>().toExtend<ByoEvent["type"]>();
    expectTypeOf<SupportEvent["occurredAt"]>().toEqualTypeOf<Date>();
    expectTypeOf<SupportEvent["actorId"]>().toEqualTypeOf<string | null>();
    expectTypeOf<SupportEvent["subject"]>().toEqualTypeOf<{
      type: "supportTicket";
      id: string;
    }>();
    expectTypeOf<SupportEvent["data"]>().toEqualTypeOf<
      Record<string, unknown>
    >();
    expectTypeOf(SUPPORT_EVENT_TYPES).toEqualTypeOf<
      readonly [
        "support.ticket.created",
        "support.ticket.status_changed",
        "support.ticket.assigned",
        "support.ticket.merged",
        "support.customer.replied",
        "support.agent.replied",
        "support.note.added",
        "support.agent.mentioned",
      ]
    >();
  });

  it("support's onEvent option takes core's handler type", () => {
    expectTypeOf<SupportOptions["onEvent"]>().toEqualTypeOf<
      ByoEventHandler | undefined
    >();
    // a handler written against ByoEvent is a valid onEvent
    const handler: ByoEventHandler = (event: ByoEvent) => void event;
    const options: SupportOptions = { onEvent: handler };
    expect(options.onEvent).toBe(handler);
  });
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

async function setup(opts: SupportOptions = {}) {
  const events: ByoEvent[] = [];
  const logged: { level: string; message: string }[] = [];
  const auth = createTestAuth(
    {
      staffOrganizationId: STAFF_ORG_ID,
      onEvent: (event) => void events.push(event),
      ...opts,
    },
    {
      authOptions: {
        logger: {
          level: "error",
          log: (level, message) => void logged.push({ level, message }),
        },
      },
    },
  );
  const world = await seedSupportWorld(auth);
  events.length = 0;
  return { auth, world, events, logged };
}

type Setup = Awaited<ReturnType<typeof setup>>;

const BODIES = {
  first: "My invoice portal shows a secret-first-body error",
  customerReply: "secret-customer-reply: still broken",
  agentReply: "secret-agent-reply: we are on it",
  note: "secret-internal-note: customer is on the legacy plan",
  second: "A duplicate request, secret-second-body",
};
const SUBJECTS = {
  first: "Invoice portal secret-subject-one",
  second: "Invoice portal secret-subject-two",
};

/**
 * Drives a real flow through the HTTP-shaped API: two tickets, a customer
 * reply, an agent reply, an internal note mentioning an agent, an
 * assignment, a status change and a merge.
 */
async function runFlow(s: Setup) {
  const { auth, world } = s;
  const customer = world.customer.headers;
  const member = world.agents.member.headers;
  const orgId = world.customerOrg.id;

  const first = (
    await auth.api.createSupportTicket({
      body: {
        subject: SUBJECTS.first,
        body: BODIES.first,
        organizationId: orgId,
      },
      headers: customer,
    })
  ).ticket;
  const second = (
    await auth.api.createSupportTicket({
      body: {
        subject: SUBJECTS.second,
        body: BODIES.second,
        organizationId: orgId,
      },
      headers: customer,
    })
  ).ticket;

  const agentReply = (
    await auth.api.replyAsSupportAgent({
      body: { ticketId: first.id, body: BODIES.agentReply },
      headers: member,
    })
  ).message;
  const customerReply = (
    await auth.api.replyToSupportTicket({
      body: { ticketId: first.id, body: BODIES.customerReply },
      headers: customer,
    })
  ).message;
  const note = (
    await auth.api.replyAsSupportAgent({
      body: {
        ticketId: first.id,
        body: BODIES.note,
        internal: true,
        mentions: [world.agents.admin.user.id],
      },
      headers: member,
    })
  ).message;
  await auth.api.updateSupportTickets({
    body: { ids: [first.id], assigneeId: world.agents.admin.user.id },
    headers: member,
  });
  await auth.api.updateSupportTickets({
    body: { ids: [first.id], status: "solved" },
    headers: member,
  });
  await auth.api.mergeSupportTickets({
    body: { sourceId: second.id, targetId: first.id },
    headers: world.agents.admin.headers,
  });
  return { first, second, agentReply, customerReply, note };
}

const ofType = (events: ByoEvent[], type: SupportEventType) =>
  events.filter((e) => e.type === type);

// ---------------------------------------------------------------------------
// Runtime: all eight events from a real flow
// ---------------------------------------------------------------------------

describe("events from a real flow", () => {
  it("emits all eight event types, each shaped like a ByoEvent", async () => {
    const s = await setup();
    await runFlow(s);

    const seen = new Set(s.events.map((e) => e.type));
    expect([...seen].sort()).toEqual([...SUPPORT_EVENT_TYPES].sort());

    for (const event of s.events) {
      expect(event.type).toMatch(/^support\.[a-z]+\.[a-z_]+$/);
      expect(SUPPORT_EVENT_TYPES).toContain(event.type);
      expect(event.occurredAt).toBeInstanceOf(Date);
      expect(Number.isNaN(event.occurredAt.getTime())).toBe(false);
      expect(event.subject.type).toBe("supportTicket");
      expect(event.subject.id).toEqual(expect.any(String));
      expect(event.data.ticketId).toBe(event.subject.id);
      // actorId is a user id or null; here every action had an actor
      expect(event.actorId).toEqual(expect.any(String));
      // optional ids are strings or absent, never null or undefined
      for (const key of ["userId", "organizationId"] as const) {
        if (key in event) expect(event[key]).toEqual(expect.any(String));
      }
      // no keys beyond the ByoEvent shape
      expect(Object.keys(event).sort()).toEqual(
        [
          "actorId",
          "data",
          "occurredAt",
          "subject",
          "type",
          ...("userId" in event ? ["userId"] : []),
          ...("organizationId" in event ? ["organizationId"] : []),
        ].sort(),
      );
    }
  });

  it("fills userId, actorId, organizationId and data as contracted", async () => {
    const s = await setup();
    const { first, second, agentReply, customerReply, note } = await runFlow(s);
    const { customer, agents, customerOrg } = s.world;
    const requester = customer.user.id;
    const orgId = customerOrg.id;
    const [member, admin] = [agents.member.user.id, agents.admin.user.id];

    const created = ofType(s.events, "support.ticket.created");
    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({
      actorId: requester,
      userId: requester,
      organizationId: orgId,
      subject: { type: "supportTicket", id: first.id },
    });
    expect(created[0]?.data).toEqual({
      ticketId: first.id,
      number: first.number,
      channel: "web",
      visibility: "private",
    });
    expect(created[1]?.subject.id).toBe(second.id);

    const [agentReplied] = ofType(s.events, "support.agent.replied");
    expect(agentReplied).toMatchObject({
      actorId: member,
      userId: requester,
      organizationId: orgId,
      subject: { type: "supportTicket", id: first.id },
    });
    expect(agentReplied?.data).toEqual({
      ticketId: first.id,
      messageId: agentReply.id,
      status: "pending",
      visibility: "private",
    });

    const [customerReplied] = ofType(s.events, "support.customer.replied");
    expect(customerReplied).toMatchObject({
      actorId: requester,
      userId: requester,
      organizationId: orgId,
    });
    expect(customerReplied?.data).toEqual({
      ticketId: first.id,
      messageId: customerReply.id,
      channel: "web",
      visibility: "private",
    });

    const [noteAdded] = ofType(s.events, "support.note.added");
    expect(noteAdded).toMatchObject({
      actorId: member,
      organizationId: orgId,
      subject: { type: "supportTicket", id: first.id },
    });
    // a note is about no one in particular: nobody to forward it to
    expect(noteAdded).not.toHaveProperty("userId");
    expect(noteAdded?.data).toEqual({
      ticketId: first.id,
      messageId: note.id,
      visibility: "private",
    });

    const [mentioned] = ofType(s.events, "support.agent.mentioned");
    expect(ofType(s.events, "support.agent.mentioned")).toHaveLength(1);
    expect(mentioned).toMatchObject({
      actorId: member,
      userId: admin,
      organizationId: orgId,
    });
    expect(mentioned?.data).toEqual({
      ticketId: first.id,
      messageId: note.id,
      kind: "note",
      visibility: "private",
    });

    const [assigned] = ofType(s.events, "support.ticket.assigned");
    expect(assigned).toMatchObject({
      actorId: member,
      userId: admin,
      organizationId: orgId,
    });
    expect(assigned?.data).toEqual({
      ticketId: first.id,
      from: null,
      to: admin,
      visibility: "private",
    });

    const changes = ofType(s.events, "support.ticket.status_changed");
    const solved = changes.find((e) => e.data.to === "solved");
    expect(solved).toMatchObject({
      actorId: member,
      userId: requester,
      organizationId: orgId,
      subject: { type: "supportTicket", id: first.id },
    });
    expect(solved?.data).toMatchObject({
      ticketId: first.id,
      to: "solved",
      visibility: "private",
    });
    expect(solved?.data.from).toEqual(expect.any(String));
    expect(solved?.data.from).not.toBe("solved");

    const [merged] = ofType(s.events, "support.ticket.merged");
    expect(ofType(s.events, "support.ticket.merged")).toHaveLength(1);
    expect(merged).toMatchObject({
      actorId: admin,
      userId: requester,
      organizationId: orgId,
      // the subject is the target
      subject: { type: "supportTicket", id: first.id },
    });
    expect(merged?.data).toEqual({
      ticketId: first.id,
      sourceId: second.id,
      targetId: first.id,
      visibility: "private",
    });
    // every event says whether its ticket is private (org fan-out skips those)
    for (const event of s.events) {
      expect(event.data.visibility, event.type).toBe("private");
    }
  });

  it("never carries a message body or a subject in an event", async () => {
    const s = await setup();
    await runFlow(s);
    expect(s.events.length).toBeGreaterThanOrEqual(8);
    const everything = JSON.stringify(s.events);
    for (const secret of [
      ...Object.values(BODIES),
      ...Object.values(SUBJECTS),
    ]) {
      expect(everything).not.toContain(secret);
    }
    expect(everything).not.toContain("secret-");
    for (const event of s.events) {
      expect(event.data).not.toHaveProperty("body");
      expect(event.data).not.toHaveProperty("subject");
      expect(event.data).not.toHaveProperty("text");
      expect(event.data).not.toHaveProperty("html");
    }
  });

  it("delivers an event after the write it describes is readable", async () => {
    const ref: { auth?: TestAuth; headers?: Headers } = {};
    const readable: boolean[] = [];
    const auth = createTestAuth({
      staffOrganizationId: STAFF_ORG_ID,
      onEvent: async (event) => {
        if (event.type !== "support.ticket.created") return;
        const found = await ref.auth?.api.getSupportTicketAsAgent({
          query: { id: event.subject.id },
          headers: ref.headers as Headers,
        });
        readable.push(found?.ticket.id === event.subject.id);
      },
    });
    ref.auth = auth;
    const world = await seedSupportWorld(auth);
    ref.headers = world.agents.member.headers;
    await auth.api.createSupportTicket({
      body: { subject: "Hello", body: "World" },
      headers: world.customer.headers,
    });
    expect(readable).toEqual([true]);
  });
});

// ---------------------------------------------------------------------------
// A broken consumer never fails the request
// ---------------------------------------------------------------------------

describe("a failing onEvent", () => {
  it.each([
    [
      "throws synchronously",
      () => {
        throw new Error("consumer exploded");
      },
    ],
    [
      "rejects",
      async () => {
        throw new Error("consumer rejected");
      },
    ],
  ])("never fails the request when it %s", async (_name, onEvent) => {
    const s = await setup({ onEvent });
    const flow = await runFlow(s);

    // every write went through: the thread has all its messages
    const detail = await s.auth.api.getSupportTicketAsAgent({
      query: { id: flow.first.id },
      headers: s.world.agents.member.headers,
    });
    const kinds = detail.messages.map((m) => m.kind);
    // first message, agent reply, customer reply, and the merged ticket's first
    expect(kinds.filter((k) => k === "reply")).toHaveLength(4);
    expect(kinds).toContain("note");
    expect(detail.ticket.status).toBe("solved");
    expect(detail.ticket.assignee?.id).toBe(s.world.agents.admin.user.id);

    // and the failures were logged, not thrown
    expect(s.logged.length).toBeGreaterThan(0);
    expect(s.logged.every((l) => l.level === "error")).toBe(true);
    expect(s.logged.some((l) => l.message.includes("onEvent failed"))).toBe(
      true,
    );
  });

  it("keeps later consumers running behind a createEventBus", async () => {
    const received: string[] = [];
    const onError = vi.fn();
    const s = await setup({
      onEvent: createEventBus(
        [
          () => {
            throw new Error("first consumer fails");
          },
          (event) => void received.push(event.type),
        ],
        { onError },
      ),
    });
    await runFlow(s);
    expect(new Set(received)).toEqual(new Set(SUPPORT_EVENT_TYPES));
    expect(onError).toHaveBeenCalled();
    // the bus caught everything, so support never even logged
    expect(s.logged).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// With @byo-oss/notifications: events become inbox notifications
// ---------------------------------------------------------------------------

/**
 * `createTestAuth` types its extra plugins loosely, so the inbox endpoints
 * wouldn't type-check on its result: this builds the same auth (strict
 * adapter, organization, support) with `inbox()` kept in the plugin tuple.
 */
function createInboxAuth(opts: SupportOptions) {
  const plugins = [testOrganization(), support(opts), inbox()] as const;
  const options = { ...mergeAuthOptions(undefined), plugins: [...plugins] };
  const db = Object.keys(getAuthTables(options)).reduce<MemoryDB>(
    (acc, table) => {
      acc[table] = [];
      return acc;
    },
    {},
  );
  return betterAuth({
    ...options,
    database: wrapAdapterFactory(memoryAdapter(db)),
  });
}
type InboxAuth = ReturnType<typeof createInboxAuth>;

describe("routing events to @byo-oss/notifications", () => {
  async function setupInbox() {
    const routed: string[] = [];
    // `auth` doesn't exist until the options have been built, so the
    // consumer reads it lazily, as an app's own module-level wiring does
    const ref: { auth?: InboxAuth } = {};
    const events: ByoEvent[] = [];

    const forward: ByoEventHandler = async (event) => {
      const auth = ref.auth;
      if (!auth) throw new Error("auth not ready");
      if (event.type === "support.agent.replied" && event.userId) {
        routed.push(event.type);
        await auth.api.notify({
          body: {
            userId: event.userId,
            type: event.type,
            title: "Support replied to your ticket",
            href: `/support/${event.subject.id}`,
            data: { ticketId: event.subject.id },
          },
        });
      }
      if (event.type === "support.agent.mentioned" && event.userId) {
        routed.push(event.type);
        await auth.api.notify({
          body: {
            userId: event.userId,
            type: event.type,
            title: "You were mentioned on a ticket",
            href: `/support/agent/${event.subject.id}`,
            data: { ticketId: event.subject.id },
          },
        });
      }
    };

    const auth = createInboxAuth({
      staffOrganizationId: STAFF_ORG_ID,
      onEvent: createEventBus([(e) => void events.push(e), forward]),
    });
    ref.auth = auth;
    const world = await seedSupportWorld(auth);
    events.length = 0;
    routed.length = 0;
    return { auth, world, routed, events };
  }

  const listFor = (
    auth: Awaited<ReturnType<typeof setupInbox>>["auth"],
    headers: Headers,
  ) =>
    auth.api.listNotifications({
      headers,
      query: { filter: "all" },
    });

  it("puts support.agent.replied in the requester's inbox", async () => {
    const s = await setupInbox();
    const ticket = (
      await s.auth.api.createSupportTicket({
        body: { subject: "Cannot log in", body: "It says no" },
        headers: s.world.customer.headers,
      })
    ).ticket;
    expect(
      (await listFor(s.auth, s.world.customer.headers)).notifications,
    ).toEqual([]);

    await s.auth.api.replyAsSupportAgent({
      body: { ticketId: ticket.id, body: "Try again now" },
      headers: s.world.agents.member.headers,
    });

    const { notifications } = await listFor(s.auth, s.world.customer.headers);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      userId: s.world.customer.user.id,
      type: "support.agent.replied",
      title: "Support replied to your ticket",
      href: `/support/${ticket.id}`,
      data: { ticketId: ticket.id },
    });
    // the notification carries no message body either
    expect(JSON.stringify(notifications)).not.toContain("Try again now");
    expect(
      (
        await s.auth.api.unreadCount({
          headers: s.world.customer.headers,
          query: {},
        })
      ).count,
    ).toBe(1);
  });

  it("does not forward support.note.added to the customer", async () => {
    const s = await setupInbox();
    const ticket = (
      await s.auth.api.createSupportTicket({
        body: { subject: "Refund", body: "Please refund" },
        headers: s.world.customer.headers,
      })
    ).ticket;

    const mentionedAgent = s.world.agents.admin;
    await s.auth.api.replyAsSupportAgent({
      body: {
        ticketId: ticket.id,
        body: "Internal: refund policy applies",
        internal: true,
        mentions: [mentionedAgent.user.id],
      },
      headers: s.world.agents.member.headers,
    });

    expect(ofType(s.events, "support.note.added")).toHaveLength(1);
    // the customer's inbox stays empty
    expect(
      (await listFor(s.auth, s.world.customer.headers)).notifications,
    ).toEqual([]);
    expect(s.routed).toEqual(["support.agent.mentioned"]);
    // the mentioned agent, not the customer, got the mention
    const agentInbox = await listFor(s.auth, mentionedAgent.headers);
    expect(agentInbox.notifications.map((n) => n.type)).toEqual([
      "support.agent.mentioned",
    ]);
    expect(JSON.stringify(agentInbox)).not.toContain("refund policy");
  });
});

// ---------------------------------------------------------------------------
// After commit: an event fires once the write it describes is durable
// ---------------------------------------------------------------------------

describe("after commit", () => {
  const DAY = 24 * 60 * 60_000;
  const sample: SupportEvent = {
    type: "support.ticket.created",
    occurredAt: new Date(),
    actorId: null,
    subject: { type: "supportTicket", id: "t1" },
    data: { ticketId: "t1", visibility: "private" },
  };

  /** A runtime whose handler logs `"handler"`, and the logs it wrote. */
  async function harness(onEvent?: ByoEventHandler) {
    const log: string[] = [];
    const errors: string[] = [];
    const auth = createTestAuth(
      {
        staffOrganizationId: STAFF_ORG_ID,
        onEvent:
          onEvent ??
          (() => {
            log.push("handler");
          }),
      },
      {
        authOptions: {
          logger: {
            level: "error",
            log: (_level, message) => void errors.push(message),
          },
        },
      },
    );
    const context = await getContext(auth);
    // the base adapter, as an endpoint sees it
    const base = await authRuntime(auth, "after-commit.test");
    // inside runWithTransaction, authRuntime resolves the transaction adapter
    const joined = () => authRuntime(auth, "after-commit.test");
    return { auth, context, base, joined, log, errors };
  }

  it("(a) drops a joined event when the transaction rolls back", async () => {
    const h = await harness();
    await expect(
      runWithTransaction(h.context.adapter, async () => {
        const rt = await h.joined();
        expect(rt.adapter).not.toBe(h.context.adapter);
        await emit(rt, sample);
        h.log.push("fn-end");
        throw new Error("caller failed");
      }),
    ).rejects.toThrow("caller failed");
    expect(h.log).toEqual(["fn-end"]);
  });

  it("(b) runs a joined event once, after the transaction resolves", async () => {
    const h = await harness();
    await runWithTransaction(h.context.adapter, async () => {
      await emit(await h.joined(), sample);
      h.log.push("fn-end");
      expect(h.log).toEqual(["fn-end"]);
    });
    expect(h.log).toEqual(["fn-end", "handler"]);
  });

  it("(c) runs a base-adapter event before emit resolves, with no transaction", async () => {
    const h = await harness();
    expect(h.base.adapter).toBe(h.context.adapter);
    await emit(h.base, sample);
    h.log.push("returned");
    expect(h.log).toEqual(["handler", "returned"]);
  });

  it("(c) runs a base-adapter event at once even inside a rolled-back transaction", async () => {
    const h = await harness();
    await expect(
      runWithTransaction(h.context.adapter, async () => {
        await emit(h.base, sample);
        h.log.push("fn-end");
        throw new Error("caller failed");
      }),
    ).rejects.toThrow("caller failed");
    expect(h.log).toEqual(["handler", "fn-end"]);
  });

  const failing: [string, ByoEventHandler][] = [
    [
      "throws synchronously",
      () => {
        throw new Error("consumer exploded");
      },
    ],
    [
      "rejects",
      async () => {
        throw new Error("consumer rejected");
      },
    ],
  ];

  describe.each(failing)("(d) a handler that %s", (_name, onEvent) => {
    it("resolves outside a transaction and logs once", async () => {
      const h = await harness(onEvent);
      await expect(emit(h.base, sample)).resolves.toBeUndefined();
      expect(h.errors.filter((m) => m.includes("onEvent failed"))).toHaveLength(
        1,
      );
    });

    it("resolves a rolled-back transaction's caller and never runs", async () => {
      const h = await harness(onEvent);
      await expect(
        runWithTransaction(h.context.adapter, async () => {
          await emit(await h.joined(), sample);
          throw new Error("caller failed");
        }),
      ).rejects.toThrow("caller failed");
      expect(h.errors.filter((m) => m.includes("onEvent failed"))).toEqual([]);
    });

    it("does not make a committed transaction reject, and logs once", async () => {
      const h = await harness(onEvent);
      await expect(
        runWithTransaction(h.context.adapter, async () => {
          await emit(await h.joined(), sample);
          return "done";
        }),
      ).resolves.toBe("done");
      expect(h.errors.filter((m) => m.includes("onEvent failed"))).toHaveLength(
        1,
      );
    });

    it("also survives a logger that throws", async () => {
      const h = await harness(onEvent);
      const broken = (rt: SupportRuntime): SupportRuntime => ({
        ...rt,
        context: {
          ...rt.context,
          logger: {
            ...rt.context.logger,
            error: () => {
              throw new Error("logger exploded");
            },
          },
        },
      });
      await expect(emit(broken(h.base), sample)).resolves.toBeUndefined();
      await expect(
        runWithTransaction(h.context.adapter, async () => {
          await emit(broken(await h.joined()), sample);
          return "done";
        }),
      ).resolves.toBe("done");
    });
  });

  it("(e) createSupportTicket in a rolled-back transaction keeps the ticket and delivers its event", async () => {
    const s = await setup();
    const { adapter } = await getContext(s.auth);
    await expect(
      runWithTransaction(adapter, async () => {
        await s.auth.api.createSupportTicket({
          body: { subject: "Hello", body: "World" },
          headers: s.world.customer.headers,
        });
        throw new Error("caller failed");
      }),
    ).rejects.toThrow("caller failed");
    // endpoint writes use the base adapter, so they don't join the caller's
    // transaction: the row stays and its event fired at once
    expect(ofType(s.events, "support.ticket.created")).toHaveLength(1);
    expect(
      await adapter.count({
        model: "supportTicket",
        where: [{ field: "subject", value: "Hello" }],
      }),
    ).toBe(1);
  });

  describe("(f) sweepAll's auto-close", () => {
    async function solvedPastClose() {
      const log: string[] = [];
      const events: ByoEvent[] = [];
      const auth = createTestAuth({
        staffOrganizationId: STAFF_ORG_ID,
        autoCloseAfter: 7 * DAY,
        onEvent: (event) => {
          events.push(event);
          log.push("handler");
        },
      });
      await seedSupportWorld(auth);
      const ticket = await insertTicket(auth, {
        status: "solved",
        solvedAt: new Date(Date.now() - 8 * DAY),
      });
      const { adapter } = await getContext(auth);
      const status = async () =>
        (
          await adapter.findOne<{ status: string }>({
            model: "supportTicket",
            where: [{ field: "id", value: ticket.id }],
          })
        )?.status;
      return { auth, adapter, events, log, status };
    }

    it("drops the event and keeps the ticket solved when fn throws after sweepAll", async () => {
      const t = await solvedPastClose();
      await expect(
        runWithTransaction(t.adapter, async () => {
          // sweepAll swallows plugin errors, so the throw comes from fn
          const swept = await sweepAll(t.auth);
          expect(swept.results[0]?.error).toBeUndefined();
          expect(swept.results[0]?.last).toMatchObject({ closed: 1 });
          t.log.push("fn-end");
          throw new Error("caller failed");
        }),
      ).rejects.toThrow("caller failed");
      expect(ofType(t.events, "support.ticket.status_changed")).toEqual([]);
      expect(t.log).toEqual(["fn-end"]);
      expect(await t.status()).toBe("solved");
    });

    it("holds the event until the commit, then delivers exactly one", async () => {
      const t = await solvedPastClose();
      await runWithTransaction(t.adapter, async () => {
        await sweepAll(t.auth);
        t.log.push("fn-end");
        expect(t.events).toHaveLength(0);
      });
      expect(t.log).toEqual(["fn-end", "handler"]);
      const changed = ofType(t.events, "support.ticket.status_changed");
      expect(changed).toHaveLength(1);
      expect(changed[0]?.data).toMatchObject({ from: "solved", to: "closed" });
      expect(await t.status()).toBe("closed");
    });

    it("still fires at once for a sweep outside a transaction", async () => {
      const t = await solvedPastClose();
      await sweepAll(t.auth);
      expect(ofType(t.events, "support.ticket.status_changed")).toHaveLength(1);
      expect(await t.status()).toBe("closed");
    });
  });
});
