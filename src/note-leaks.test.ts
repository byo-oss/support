// Internal notes are staff-only. This plants unique markers in a note, its
// mention and its internal attachment, then gathers everything that leaves the
// server toward a customer (raw HTTP bodies, events, mail) and fails if a
// marker is in any of it. A positive control proves the markers are findable
// where they belong, so a passing scan is not a vacuous one.

import type { ByoEvent } from "@byo-oss/core";
import { type MailMessage, memoryMailer } from "@byo-oss/mailer";
import { describe, expect, it } from "vitest";
import { authRuntime } from "./adapter";
import { runSweep } from "./delivery";
import {
  createTestAuth,
  STAFF_ORG_ID,
  seedSupportWorld,
  type TestUser,
} from "./test-utils";
import { memoryStorage } from "./testing/storage";

const ORIGIN = "http://localhost:3000";
const BASE = `${ORIGIN}/api/auth`;

const SECRET = {
  body: "zz-secret-note-body-7f3a: customer is on the legacy plan",
  filename: "zz-secret-file-7f3a.txt",
  content: "zz-secret-file-content-7f3a",
};
const PUBLIC_REPLY = "We are looking into it";
const DELAY = 2 * 60_000;

async function setup() {
  const events: ByoEvent[] = [];
  const storage = memoryStorage();
  const mailer = memoryMailer();
  const auth = createTestAuth({
    staffOrganizationId: STAFF_ORG_ID,
    attachments: { storage },
    mailer,
    email: {
      from: "Support <support@vendor.test>",
      replyDomain: "reply.vendor.test",
      appUrl: "https://app.vendor.test",
      replyDelay: DELAY,
    },
    onEvent: (event) => void events.push(event),
  });
  const w = await seedSupportWorld(auth);
  events.length = 0;

  /** A request through the real handler: the bytes a client would receive. */
  async function wire(
    user: TestUser,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ) {
    const headers = new Headers(user.headers);
    headers.set("origin", ORIGIN);
    let payload: BodyInit | undefined;
    if (body instanceof Uint8Array) {
      headers.set("content-type", "text/plain");
      headers.set("content-length", String(body.byteLength));
      payload = body as Uint8Array<ArrayBuffer>;
    } else if (body !== undefined) {
      headers.set("content-type", "application/json");
      payload = JSON.stringify(body);
    }
    const response = await auth.handler(
      new Request(`${BASE}${path}`, { method, headers, body: payload }),
    );
    return { status: response.status, text: await response.text() };
  }

  return { auth, w, events, storage, mailer, wire };
}

/** A shared ticket, a public reply, then a note with a mention and an internal file. */
async function scenario() {
  const s = await setup();
  const { auth, w, wire } = s;
  const member = w.agents.member;

  const { ticket } = await auth.api.createSupportTicket({
    body: {
      subject: "Invoice portal",
      body: "It shows an error",
      organizationId: w.customerOrg.id,
      visibility: "organization",
    },
    headers: w.customer.headers,
  });
  await auth.api.replyAsSupportAgent({
    body: { ticketId: ticket.id, body: PUBLIC_REPLY },
    headers: member.headers,
  });

  const customerView = async (user: TestUser) =>
    JSON.parse(
      (await wire(user, "GET", `/support/ticket?id=${ticket.id}`)).text,
    ).ticket as { lastMessageAt: string; updatedAt: string; unread: boolean };
  const before = await customerView(w.customer);

  await new Promise((resolve) => setTimeout(resolve, 5));
  const upload = await wire(
    member,
    "POST",
    `/support/agent/upload?ticketId=${ticket.id}&filename=${SECRET.filename}&internal=true`,
    new TextEncoder().encode(SECRET.content),
  );
  expect(upload.status).toBe(200);
  const attachmentId = JSON.parse(upload.text).attachment.id as string;
  const { message: note } = await auth.api.replyAsSupportAgent({
    body: {
      ticketId: ticket.id,
      body: SECRET.body,
      internal: true,
      mentions: [w.agents.admin.user.id],
      attachmentIds: [attachmentId],
    },
    headers: member.headers,
  });
  const after = await customerView(w.customer);

  // send what is due: the public reply goes out, the note must not, even with
  // a delivery row for it (as if `enqueueReply` had let it through)
  const rt = await authRuntime(auth, "note-leaks.test");
  await rt.adapter.create({
    model: "supportDelivery",
    data: {
      messageId: note.id,
      ticketId: ticket.id,
      status: "pending",
      scheduledFor: new Date(),
      claimedAt: null,
      attempts: 0,
      detail: null,
      providerId: null,
      createdAt: new Date(),
    },
  });
  await runSweep(rt, new Date(Date.now() + DELAY + 1_000));

  // everything a customer-side caller can reach, as raw response bodies
  const wireBodies: string[] = [];
  for (const user of [w.customer, w.teammate, w.outsider]) {
    for (const [method, path, body] of [
      ["GET", `/support/ticket?id=${ticket.id}`],
      ["GET", "/support/my-tickets"],
      ["GET", `/support/my-tickets?q=${SECRET.body.slice(0, 12)}`],
      ["GET", `/support/attachment?id=${attachmentId}`],
      ["POST", "/support/mark-seen", { id: ticket.id }],
      ["POST", "/support/reply", { ticketId: ticket.id, body: "thanks" }],
      ["POST", "/support/update-mine", { id: ticket.id, rating: "good" }],
      ["GET", `/support/ticket?id=${ticket.id}`],
    ] as const) {
      const res = await wire(user, method, path, body);
      wireBodies.push(res.text);
      // the internal file is a 404 for every customer-side caller
      if (path.startsWith("/support/attachment")) expect(res.status).toBe(404);
    }
  }

  return { ...s, ticket, note, attachmentId, before, after, wireBodies };
}

describe("internal notes never leave toward a customer", () => {
  it("is a scan that can see the markers where they belong (positive control)", async () => {
    const s = await scenario();
    const staff = await s.wire(
      s.w.agents.member,
      "GET",
      `/support/agent/ticket?id=${s.ticket.id}`,
    );
    expect(staff.text).toContain(SECRET.body);
    expect(staff.text).toContain(s.note.id);
    expect(staff.text).toContain(s.attachmentId);
    expect(staff.text).toContain(SECRET.filename);
    const staffFile = await s.wire(
      s.w.agents.member,
      "GET",
      `/support/agent/attachment?id=${s.attachmentId}`,
    );
    expect(staffFile.text).toBe(SECRET.content);
    // the note events exist, so the event scans below have something to scan
    expect(s.events.map((e) => e.type)).toEqual(
      expect.arrayContaining(["support.note.added", "support.agent.mentioned"]),
    );
    // and the public reply did go out by mail
    expect(s.mailer.sent).toHaveLength(1);
  });

  it("sends nothing of the note in any response a customer-side caller can get", async () => {
    const s = await scenario();
    const wire = s.wireBodies.join("\n");
    for (const needle of [
      SECRET.body,
      SECRET.filename,
      SECRET.content,
      s.note.id,
      s.attachmentId,
    ]) {
      expect(wire).not.toContain(needle);
    }
    // the public reply is still there: the scan ran over real content
    expect(wire).toContain(PUBLIC_REPLY);
  });

  it("leaves no activity trace of a note: lastMessageAt, updatedAt and unread don't move", async () => {
    const s = await scenario();
    expect(s.after).toEqual(s.before);
  });

  it("puts no note content in any event", async () => {
    const s = await scenario();
    const json = JSON.stringify(s.events);
    for (const needle of [SECRET.body, SECRET.filename, SECRET.content]) {
      expect(json).not.toContain(needle);
    }
    expect(json).not.toContain(s.attachmentId);
  });

  it("addresses note events to staff only: no customer organization, no customer user", async () => {
    const s = await scenario();
    const staffIds = new Set(
      Object.values(s.w.agents).map((agent) => agent.user.id),
    );
    const aboutNote = s.events.filter(
      (e) =>
        e.type === "support.note.added" ||
        e.data.messageId === s.note.id ||
        e.data.kind === "note",
    );
    expect(aboutNote.map((e) => e.type).sort()).toEqual([
      "support.agent.mentioned",
      "support.note.added",
    ]);
    for (const event of aboutNote) {
      // the key a handler would fan out by is not there
      expect(event).not.toHaveProperty("organizationId");
      if (event.userId) expect(staffIds.has(event.userId)).toBe(true);
      expect(staffIds.has(event.actorId as string)).toBe(true);
    }
  });

  it("reaches no customer through a handler that fans every event out by organization and userId", async () => {
    const s = await scenario();
    const customerSide = new Set([
      s.w.customer.user.id,
      s.w.teammate.user.id,
      s.w.outsider.user.id,
    ]);
    // the naive router: the event's user, plus the whole customer organization
    // of a shared ticket. Documented consumers do exactly this for replies.
    const recipients = (event: ByoEvent): string[] => {
      const out = event.userId ? [event.userId] : [];
      if (event.organizationId && event.data.visibility === "organization") {
        out.push(s.w.customer.user.id, s.w.teammate.user.id);
      }
      return out;
    };
    const aboutNote = s.events.filter(
      (e) => e.type === "support.note.added" || e.data.kind === "note",
    );
    expect(aboutNote.length).toBeGreaterThan(0);
    for (const event of aboutNote) {
      expect(recipients(event).filter((id) => customerSide.has(id))).toEqual(
        [],
      );
    }
    // control: the same router does reach the customer organization for a reply
    const reply = s.events.find((e) => e.type === "support.agent.replied");
    expect(
      recipients(reply as ByoEvent).filter((id) => customerSide.has(id)),
    ).not.toEqual([]);
  });

  it("mails the public reply and nothing of the note", async () => {
    const s = await scenario();
    const sent: MailMessage[] = s.mailer.sent;
    expect(sent).toHaveLength(1);
    const json = JSON.stringify(sent);
    expect(json).toContain(PUBLIC_REPLY);
    for (const needle of [
      SECRET.body,
      SECRET.filename,
      SECRET.content,
      s.note.id,
      s.attachmentId,
    ]) {
      expect(json).not.toContain(needle);
    }
  });
});
