import type { ByoEvent } from "@byo-oss/core";
import { beforeAll, describe, expect, it } from "vitest";
import { authRuntime } from "./adapter";
import { SUPPORT_ERROR_CODES } from "./error-codes";
import { SUPPORT_LIMITS } from "./options";
import type { SupportCannedReplyRow, SupportMessageRow } from "./schema";
import {
  createTestAuth,
  getContext,
  STAFF_ORG_ID,
  seedSupportWorld,
} from "./test-utils";
import { createTicket } from "./tickets";

async function setup() {
  const events: ByoEvent[] = [];
  const auth = createTestAuth({
    staffOrganizationId: STAFF_ORG_ID,
    onEvent: (event) => void events.push(event),
  });
  const world = await seedSupportWorld(auth);
  const rt = await authRuntime(auth, "agent-canned.test");
  return { auth, world, rt, events };
}

type Setup = Awaited<ReturnType<typeof setup>>;

const failsWith = (status: string, code: { code: string }) =>
  expect.objectContaining({
    status,
    body: expect.objectContaining({ code: code.code }),
  });

const notAllowed = failsWith("FORBIDDEN", SUPPORT_ERROR_CODES.NOT_ALLOWED);

describe("canned replies (PRD #14: CRUD needs support:manage)", () => {
  let s: Setup;
  beforeAll(async () => {
    s = await setup();
  });

  it("an agent with support:manage creates, edits and deletes; the author is kept on edit", async () => {
    const admin = s.world.agents.admin.headers;
    const created = await s.auth.api.saveSupportCannedReply({
      body: { title: "  Refund policy ", body: "Refunds take 5 days." },
      headers: admin,
    });
    expect(created.cannedReply).toMatchObject({
      title: "Refund policy",
      body: "Refunds take 5 days.",
      userId: s.world.agents.admin.user.id,
    });
    const { id, createdAt } = created.cannedReply;

    const edited = await s.auth.api.saveSupportCannedReply({
      body: { id, title: "Refunds", body: "Refunds take 3 days." },
      headers: s.world.agents.owner.headers,
    });
    expect(edited.cannedReply).toMatchObject({
      id,
      title: "Refunds",
      body: "Refunds take 3 days.",
      userId: s.world.agents.admin.user.id,
    });
    expect(new Date(edited.cannedReply.createdAt)).toEqual(new Date(createdAt));
    expect(
      new Date(edited.cannedReply.updatedAt).getTime(),
    ).toBeGreaterThanOrEqual(new Date(createdAt).getTime());

    await expect(
      s.auth.api.deleteSupportCannedReply({ body: { id }, headers: admin }),
    ).resolves.toEqual({ ok: true });
    // already gone: still ok
    await expect(
      s.auth.api.deleteSupportCannedReply({ body: { id }, headers: admin }),
    ).resolves.toEqual({ ok: true });
    const list = await s.auth.api.listSupportCannedReplies({
      query: {},
      headers: admin,
    });
    expect(list.map((c) => c.id)).not.toContain(id);
  });

  it("saving with an unknown id is 404 CANNED_REPLY_NOT_FOUND", async () => {
    await expect(
      s.auth.api.saveSupportCannedReply({
        body: { id: "missing", title: "x", body: "y" },
        headers: s.world.agents.admin.headers,
      }),
    ).rejects.toEqual(
      failsWith("NOT_FOUND", SUPPORT_ERROR_CODES.CANNED_REPLY_NOT_FOUND),
    );
  });

  it("a reader (support:read only) lists but can't save or delete", async () => {
    const { cannedReply } = await s.auth.api.saveSupportCannedReply({
      body: { title: "Greeting", body: "Hello!" },
      headers: s.world.agents.owner.headers,
    });
    for (const role of ["readOnly", "member", "lacksManage"] as const) {
      const headers = s.world.agents[role].headers;
      const list = await s.auth.api.listSupportCannedReplies({
        query: {},
        headers,
      });
      expect(list.map((c) => c.id)).toContain(cannedReply.id);
      await expect(
        s.auth.api.saveSupportCannedReply({
          body: { title: "Nope", body: "Nope" },
          headers,
        }),
      ).rejects.toEqual(notAllowed);
      await expect(
        s.auth.api.saveSupportCannedReply({
          body: { id: cannedReply.id, title: "Hijack", body: "Nope" },
          headers,
        }),
      ).rejects.toEqual(notAllowed);
      await expect(
        s.auth.api.deleteSupportCannedReply({
          body: { id: cannedReply.id },
          headers,
        }),
      ).rejects.toEqual(notAllowed);
    }
    const rt = await authRuntime(s.auth, "agent-canned.test");
    const row = await rt.adapter.findOne<SupportCannedReplyRow>({
      model: "supportCannedReply",
      where: [{ field: "id", value: cannedReply.id }],
    });
    expect(row?.title).toBe("Greeting");
  });

  it("listing needs support:read; customers and billing staff are denied everything", async () => {
    // lacksRead has every action but read: it manages, but can't list
    const lacksRead = s.world.agents.lacksRead.headers;
    await expect(
      s.auth.api.listSupportCannedReplies({ query: {}, headers: lacksRead }),
    ).rejects.toEqual(notAllowed);
    await expect(
      s.auth.api.saveSupportCannedReply({
        body: { title: "Manager", body: "Saved without read" },
        headers: lacksRead,
      }),
    ).resolves.toBeDefined();
    for (const user of [
      s.world.customer,
      s.world.agents.billing,
      s.world.outsider,
    ]) {
      await expect(
        s.auth.api.listSupportCannedReplies({
          query: {},
          headers: user.headers,
        }),
      ).rejects.toEqual(notAllowed);
      await expect(
        s.auth.api.saveSupportCannedReply({
          body: { title: "x", body: "y" },
          headers: user.headers,
        }),
      ).rejects.toEqual(notAllowed);
    }
  });
});

describe("listSupportCannedReplies", () => {
  it("sorts by title and filters by q (contains, case-insensitive)", async () => {
    const s = await setup();
    const headers = s.world.agents.owner.headers;
    for (const title of ["Shipping delay", "Apology", "Password RESET"]) {
      await s.auth.api.saveSupportCannedReply({
        body: { title, body: `${title} body` },
        headers,
      });
    }
    const all = await s.auth.api.listSupportCannedReplies({
      query: {},
      headers,
    });
    expect(all.map((c) => c.title)).toEqual([
      "Apology",
      "Password RESET",
      "Shipping delay",
    ]);
    const found = await s.auth.api.listSupportCannedReplies({
      query: { q: "reset" },
      headers,
    });
    expect(found.map((c) => c.title)).toEqual(["Password RESET"]);
  });

  it("returns at most 200", async () => {
    const s = await setup();
    const { adapter } = await getContext(s.auth);
    const now = new Date();
    for (let i = 0; i < SUPPORT_LIMITS.cannedListed + 5; i++) {
      await adapter.create({
        model: "supportCannedReply",
        data: {
          title: `Reply ${String(i).padStart(3, "0")}`,
          body: "b",
          createdAt: now,
          updatedAt: now,
        },
      });
    }
    const list = await s.auth.api.listSupportCannedReplies({
      query: {},
      headers: s.world.agents.readOnly.headers,
    });
    expect(list).toHaveLength(SUPPORT_LIMITS.cannedListed);
    expect(list[0]?.title).toBe("Reply 000");
  });
});

describe("mentions (PRD #14: one support.agent.mentioned per mentioned agent)", () => {
  it("emits one event per distinct mentioned agent on replies and notes", async () => {
    const s = await setup();
    const { ticket } = await createTicket(s.rt, {
      subject: "Help",
      body: "Hi",
      channel: "web",
      userId: s.world.customer.user.id,
      verified: true,
      actorId: s.world.customer.user.id,
    });
    const a = s.world.agents.readOnly.user.id;
    const b = s.world.agents.admin.user.id;

    for (const internal of [true, false]) {
      s.events.length = 0;
      const res = await s.auth.api.replyAsSupportAgent({
        body: {
          ticketId: ticket.id,
          body: "Can you look?",
          internal,
          mentions: [a, b, a],
        },
        headers: s.world.agents.member.headers,
      });
      expect(res.message.mentions).toEqual([a, b]);
      const mentioned = s.events.filter(
        (e) => e.type === "support.agent.mentioned",
      );
      expect(mentioned.map((e) => e.userId)).toEqual([a, b]);
      for (const event of mentioned) {
        expect(event).toMatchObject({
          actorId: s.world.agents.member.user.id,
          subject: { type: "supportTicket", id: ticket.id },
          data: {
            ticketId: ticket.id,
            messageId: res.message.id,
            kind: internal ? "note" : "reply",
          },
        });
      }
      const stored = await s.rt.adapter.findOne<SupportMessageRow>({
        model: "supportMessage",
        where: [{ field: "id", value: res.message.id }],
      });
      expect(stored?.mentions).toEqual([a, b]);
    }
  });

  it("no mentions: no mention events", async () => {
    const s = await setup();
    const { ticket } = await createTicket(s.rt, {
      subject: "Help",
      body: "Hi",
      channel: "web",
      userId: s.world.customer.user.id,
      verified: true,
      actorId: s.world.customer.user.id,
    });
    s.events.length = 0;
    await s.auth.api.replyAsSupportAgent({
      body: { ticketId: ticket.id, body: "Note", internal: true },
      headers: s.world.agents.member.headers,
    });
    expect(s.events.map((e) => e.type)).toEqual(["support.note.added"]);
  });

  it("a non-agent mention fails with NOT_AN_AGENT and emits nothing", async () => {
    const s = await setup();
    const { ticket } = await createTicket(s.rt, {
      subject: "Help",
      body: "Hi",
      channel: "web",
      userId: s.world.customer.user.id,
      verified: true,
      actorId: s.world.customer.user.id,
    });
    s.events.length = 0;
    await expect(
      s.auth.api.replyAsSupportAgent({
        body: {
          ticketId: ticket.id,
          body: "Hey",
          internal: true,
          mentions: [s.world.agents.admin.user.id, s.world.teammate.user.id],
        },
        headers: s.world.agents.member.headers,
      }),
    ).rejects.toEqual(
      failsWith("BAD_REQUEST", SUPPORT_ERROR_CODES.NOT_AN_AGENT),
    );
    expect(s.events).toEqual([]);
  });
});
