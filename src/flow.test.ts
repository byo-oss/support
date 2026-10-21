// Whole-package flows through the public surface: an agent reply becomes a
// delivery that the sweep mails (reply token in `replyTo`), mail arrives
// through the relay endpoint with its secret, and a real better-auth client
// satisfies the React hooks' client type.
import { type MemoryMailer, memoryMailer } from "@byo-oss/mailer";
import { createAuthClient } from "better-auth/react";
import { describe, expect, it } from "vitest";
import { authRuntime } from "./adapter";
import { supportClient } from "./client";
import { runSweep } from "./delivery";
import { rawRelay } from "./inbound/raw-relay";
import type { SupportOptions } from "./options";
import type { SupportFetchClient } from "./react/hooks";
import type { SupportDeliveryRow, SupportTicketRow } from "./schema";
import {
  createTestAuth,
  getContext,
  STAFF_ORG_ID,
  seedSupportWorld,
  type TestAuth,
} from "./test-utils";

const REPLY_DOMAIN = "reply.vendor.test";
const SECRET = "relay-secret-for-flow-tests";

const EMAIL = {
  from: "Support <support@vendor.test>",
  replyDomain: REPLY_DOMAIN,
  appUrl: "https://app.vendor.test",
  replyDelay: 0,
};

/** The clock must move between the customer's ticket and the agent's reply. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

async function setup(opts: SupportOptions = {}) {
  const mailer = memoryMailer();
  const auth = createTestAuth({
    staffOrganizationId: STAFF_ORG_ID,
    mailer,
    email: EMAIL,
    ...opts,
  });
  const world = await seedSupportWorld(auth);
  return { auth, world, mailer };
}

async function rows<T>(
  auth: TestAuth,
  model: "supportTicket" | "supportDelivery",
) {
  const { adapter } = await getContext(auth);
  return adapter.findMany<T>({ model, limit: 1000 });
}

describe("agent reply to mailed delivery", () => {
  async function replied() {
    const s = await setup();
    const { ticket } = await s.auth.api.createSupportTicket({
      body: { subject: "Cannot export", body: "The export button is grey" },
      headers: s.world.customer.headers,
    });
    await tick();
    const { message } = await s.auth.api.replyAsSupportAgent({
      body: { ticketId: ticket.id, body: "Fixed in the next release" },
      headers: s.world.agents.member.headers,
    });
    return { ...s, ticket, message };
  }

  it("records a supportDelivery row for the reply, and sends nothing yet", async () => {
    const s = await replied();
    const deliveries = await rows<SupportDeliveryRow>(
      s.auth,
      "supportDelivery",
    );
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      messageId: s.message.id,
      ticketId: s.ticket.id,
      status: "pending",
      attempts: 0,
    });
    expect((s.mailer as MemoryMailer).sent).toHaveLength(0);
  });

  it("processSupportDeliveries sends it through the mailer with the reply token in replyTo", async () => {
    const s = await replied();
    const [stored] = await rows<SupportTicketRow>(s.auth, "supportTicket");
    expect(stored?.replyToken).toEqual(expect.any(String));

    const result = await s.auth.api.processSupportDeliveries({});
    expect(result).toMatchObject({ sent: 1, failed: 0, hasMore: false });

    const sent = (s.mailer as MemoryMailer).sent;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: s.world.customer.user.email,
      subject: `[#${s.ticket.number}] Cannot export`,
      replyTo: `support+${stored?.replyToken}@${REPLY_DOMAIN}`,
    });
    expect(sent[0]?.text).toContain("Fixed in the next release");
    // replyTo is its own field, never smuggled into headers
    expect(
      Object.keys(sent[0]?.headers ?? {}).map((k) => k.toLowerCase()),
    ).not.toContain("reply-to");

    const [delivery] = await rows<SupportDeliveryRow>(
      s.auth,
      "supportDelivery",
    );
    expect(delivery).toMatchObject({ status: "sent", attempts: 1 });
  });

  it("runSweep does the same for a runtime built from the auth", async () => {
    const s = await replied();
    const rt = await authRuntime(s.auth, "flow.test");
    expect(await runSweep(rt)).toMatchObject({ sent: 1, hasMore: false });
    expect((s.mailer as MemoryMailer).sent).toHaveLength(1);
    // nothing is sent twice
    expect(await runSweep(rt)).toMatchObject({ sent: 0 });
    expect((s.mailer as MemoryMailer).sent).toHaveLength(1);
  });

  it("an internal note is never delivered", async () => {
    const s = await replied();
    await s.auth.api.replyAsSupportAgent({
      body: { ticketId: s.ticket.id, body: "Internal only", internal: true },
      headers: s.world.agents.member.headers,
    });
    await s.auth.api.processSupportDeliveries({});
    const sent = (s.mailer as MemoryMailer).sent;
    expect(sent).toHaveLength(1);
    expect(sent.map((m) => m.text).join("\n")).not.toContain("Internal only");
  });
});

describe("rawRelay end to end", () => {
  const message = (subject = "Where is my invoice?") =>
    [
      "From: Alice Example <alice@customer.test>",
      `To: support@${REPLY_DOMAIN}`,
      `Subject: ${subject}`,
      "Message-ID: <flow-1@customer.test>",
      "Date: Tue, 20 Oct 2026 09:30:00 +0000",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "I never got the invoice for September.",
      "",
    ].join("\r\n");

  async function relay() {
    const s = await setup({
      inbound: { source: rawRelay({ secret: SECRET }) },
    });
    const post = (secret: string | null, body: string = message()) =>
      s.auth.handler(
        new Request("http://localhost:3000/api/auth/support/inbound", {
          method: "POST",
          headers: {
            "content-type": "message/rfc822",
            ...(secret === null ? {} : { authorization: `Bearer ${secret}` }),
          },
          body,
        }),
      );
    return { ...s, post };
  }

  it("answers 401 for a wrong secret and stores nothing", async () => {
    const s = await relay();
    expect((await s.post("not-the-secret")).status).toBe(401);
    expect((await s.post(SECRET.toUpperCase())).status).toBe(401);
    expect((await s.post(null)).status).toBe(401);
    expect(await rows(s.auth, "supportTicket")).toEqual([]);
  });

  it("answers 202 for the right secret and a valid unsigned message, and opens a ticket", async () => {
    const s = await relay();
    const res = await s.post(SECRET);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });

    const tickets = await rows<SupportTicketRow>(s.auth, "supportTicket");
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({
      channel: "email",
      subject: "Where is my invoice?",
      requesterEmail: "alice@customer.test",
    });
    // no DKIM signature: the sender is not verified, and no account is linked
    expect(tickets[0]?.verified).toBe(false);
    expect(tickets[0]?.userId ?? null).toBeNull();
  });

  it("answers 202 again for the same Message-ID without a second ticket", async () => {
    const s = await relay();
    expect((await s.post(SECRET)).status).toBe(202);
    expect((await s.post(SECRET)).status).toBe(202);
    expect(await rows(s.auth, "supportTicket")).toHaveLength(1);
  });

  it("answers 404 INBOUND_NOT_CONFIGURED when no inbound source is set", async () => {
    const s = await setup();
    const res = await s.auth.handler(
      new Request("http://localhost:3000/api/auth/support/inbound", {
        method: "POST",
        headers: { authorization: `Bearer ${SECRET}` },
        body: message(),
      }),
    );
    expect(res.status).toBe(404);
  });
});

describe("the React hooks' client type", () => {
  it("a better-auth client with supportClient() assigns to SupportFetchClient", () => {
    const client: SupportFetchClient = createAuthClient({
      plugins: [supportClient()],
    });
    // a real client, not a stub: its support namespace has the methods
    expect(typeof client.support.createTicket).toBe("function");
    expect(typeof client.support.agent.tickets).toBe("function");
  });
});
