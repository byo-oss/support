// PRD acceptance #11 on a real SQL database (PGlite), where updateMany's
// returned count can't be relied on.
import { afterEach, describe, expect, it } from "vitest";
import { linkSupportRequester } from "./link";
import type { SupportMessageRow, SupportTicketRow } from "./schema";
import { createSqlTestAuth } from "./test-sql";
import {
  getContext,
  insertMessage,
  insertTicket,
  signUpUser,
  verifyEmail,
} from "./test-utils";

const PAT = "pat@example.test";

type Harness = Awaited<ReturnType<typeof createSqlTestAuth>>;
let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function setup() {
  harness = await createSqlTestAuth();
  return harness.auth;
}

/** An account-less, verified email ticket from `PAT` with its first message. */
async function seedEmailTicket(auth: Harness["auth"]) {
  const ticket = await insertTicket(auth, {
    channel: "email",
    requesterEmail: PAT,
    requesterName: "Pat",
  });
  const message = await insertMessage(auth, {
    ticketId: ticket.id,
    channel: "email",
    authorEmail: PAT,
    authorName: "Pat",
  });
  return { ticket, message };
}

async function rows(auth: Harness["auth"]) {
  const { adapter } = await getContext(auth);
  const tickets = await adapter.findMany<SupportTicketRow>({
    model: "supportTicket",
    where: [],
    limit: 1000,
  });
  const messages = await adapter.findMany<SupportMessageRow>({
    model: "supportMessage",
    where: [],
    limit: 1000,
  });
  return { tickets, messages };
}

describe("linking on SQL (PRD #11)", () => {
  it("links a verified email-only ticket and message on a verified sign-up", async () => {
    const auth = await setup();
    const { ticket, message } = await seedEmailTicket(auth);
    const unverified = await insertTicket(auth, {
      channel: "email",
      requesterEmail: PAT,
      verified: false,
    });
    const pat = await signUpUser(auth, "Pat@Example.TEST", { verified: true });

    const { tickets, messages } = await rows(auth);
    const linked = tickets.find((t) => t.id === ticket.id);
    expect(linked?.userId).toBe(pat.user.id);
    expect(linked?.requesterEmail ?? null).toBeNull();
    expect(linked?.requesterName ?? null).toBeNull();
    const linkedMessage = messages.find((m) => m.id === message.id);
    expect(linkedMessage?.userId).toBe(pat.user.id);
    expect(linkedMessage?.authorEmail ?? null).toBeNull();
    expect(linkedMessage?.authorName ?? null).toBeNull();
    const kept = tickets.find((t) => t.id === unverified.id);
    expect(kept?.userId ?? null).toBeNull();
    expect(kept?.requesterEmail).toBe(PAT);
  });

  it("linkSupportRequester returns the counts it linked", async () => {
    const auth = await setup();
    const pat = await signUpUser(auth, PAT, { verified: true });
    await seedEmailTicket(auth);
    await seedEmailTicket(auth);

    expect(await linkSupportRequester(auth, pat.user.id)).toEqual({
      tickets: 2,
      messages: 2,
    });
    expect(await linkSupportRequester(auth, pat.user.id)).toEqual({
      tickets: 0,
      messages: 0,
    });
    const { tickets } = await rows(auth);
    expect(tickets.every((t) => t.userId === pat.user.id)).toBe(true);
  });

  it("links more than one chunk (> 90 rows)", async () => {
    const auth = await setup();
    const pat = await signUpUser(auth, PAT);
    for (let i = 0; i < 95; i++) await seedEmailTicket(auth);
    await verifyEmail(auth, pat.user.id);

    const { tickets, messages } = await rows(auth);
    expect(tickets).toHaveLength(95);
    expect(tickets.every((t) => t.userId === pat.user.id)).toBe(true);
    expect(messages.every((m) => m.userId === pat.user.id)).toBe(true);
    expect(tickets.every((t) => (t.requesterEmail ?? null) === null)).toBe(
      true,
    );
  });

  it("linkSupportRequester counts more than one chunk", async () => {
    const auth = await setup();
    const pat = await signUpUser(auth, PAT, { verified: true });
    for (let i = 0; i < 95; i++) await seedEmailTicket(auth);
    expect(await linkSupportRequester(auth, pat.user.id)).toEqual({
      tickets: 95,
      messages: 95,
    });
  });
});
