import { beforeEach, describe, expect, it } from "vitest";
import { SUPPORT_ERROR_CODES } from "./error-codes";
import type { SupportAcceptSessionInput, SupportOptions } from "./options";
import type { SupportMessageRow, SupportTicketRow } from "./schema";
import {
  createTestAuth,
  getContext,
  impersonatedHeaders,
  STAFF_ORG_ID,
  type SupportTestWorld,
  seedSupportWorld,
  type TestAuth,
} from "./test-utils";

// PRD #7, customer half: every customer endpoint asks `acceptSession` first,
// reads included.

const notAccepted = expect.objectContaining({
  status: "FORBIDDEN",
  body: expect.objectContaining({
    code: SUPPORT_ERROR_CODES.SESSION_NOT_ACCEPTED.code,
  }),
});
const unauthorized = expect.objectContaining({ status: "UNAUTHORIZED" });

let auth: TestAuth;
let w: SupportTestWorld;
let ticketId: string;

async function setup(opts: SupportOptions = {}) {
  auth = createTestAuth({ staffOrganizationId: STAFF_ORG_ID, ...opts });
  w = await seedSupportWorld(auth);
  const { ticket } = await auth.api.createSupportTicket({
    body: { subject: "Existing", body: "Hello" },
    headers: w.customer.headers,
  });
  ticketId = ticket.id;
}

/** Each customer endpoint, called with valid input on the customer's own ticket. */
const endpoints = {
  createSupportTicket: (headers: Headers) =>
    auth.api.createSupportTicket({
      body: { subject: "New", body: "Body" },
      headers,
    }),
  listMySupportTickets: (headers: Headers) =>
    auth.api.listMySupportTickets({ query: {}, headers }),
  getSupportTicket: (headers: Headers) =>
    auth.api.getSupportTicket({ query: { id: ticketId }, headers }),
  replyToSupportTicket: (headers: Headers) =>
    auth.api.replyToSupportTicket({
      body: { ticketId, body: "A reply" },
      headers,
    }),
  updateMySupportTicket: (headers: Headers) =>
    auth.api.updateMySupportTicket({
      body: { id: ticketId, status: "solved", rating: "good" },
      headers,
    }),
  markSupportTicketSeen: (headers: Headers) =>
    auth.api.markSupportTicketSeen({ body: { id: ticketId }, headers }),
};
type EndpointName = keyof typeof endpoints;
const NAMES = Object.keys(endpoints) as EndpointName[];

/** What every endpoint could have written: the tickets and all their messages. */
async function snapshot() {
  const { adapter } = await getContext(auth);
  const tickets = await adapter.findMany<SupportTicketRow>({
    model: "supportTicket",
    where: [],
    limit: 100,
  });
  const messages = await adapter.findMany<SupportMessageRow>({
    model: "supportMessage",
    where: [],
    limit: 100,
  });
  return { tickets, messages };
}

const withHeader = (base: Headers, name: string, value: string) => {
  const headers = new Headers(base);
  headers.set(name, value);
  return headers;
};

describe("default acceptSession: impersonated sessions are refused", () => {
  beforeEach(() => setup());

  it.each(NAMES)(
    "%s answers 403 SESSION_NOT_ACCEPTED and writes nothing",
    async (name) => {
      const headers = await impersonatedHeaders(auth, w.customer.user.email);
      const before = await snapshot();
      await expect(endpoints[name](headers)).rejects.toEqual(notAccepted);
      expect(await snapshot()).toEqual(before);
    },
  );

  it.each(NAMES)("%s works for the same user's own session", async (name) => {
    await expect(endpoints[name](w.customer.headers)).resolves.toBeTruthy();
  });

  it("refuses before looking at the ticket (no existence leak)", async () => {
    const headers = await impersonatedHeaders(auth, w.customer.user.email);
    await expect(
      auth.api.getSupportTicket({ query: { id: "missing" }, headers }),
    ).rejects.toEqual(notAccepted);
    const teammate = await impersonatedHeaders(auth, w.teammate.user.email);
    await expect(
      auth.api.getSupportTicket({ query: { id: ticketId }, headers: teammate }),
    ).rejects.toEqual(notAccepted);
  });
});

describe("an app acceptSession that refuses bearer and API-key sessions", () => {
  let seen: SupportAcceptSessionInput[];

  beforeEach(async () => {
    seen = [];
    await setup({
      acceptSession: (input) => {
        seen.push(input);
        const authorization = input.headers.get("authorization") ?? "";
        return (
          !/^bearer\s/i.test(authorization) && !input.headers.has("x-api-key")
        );
      },
    });
    seen = [];
  });

  it.each(NAMES)("%s refuses a bearer session with 403", async (name) => {
    const headers = withHeader(
      w.customer.headers,
      "authorization",
      "Bearer token-123",
    );
    const before = await snapshot();
    await expect(endpoints[name](headers)).rejects.toEqual(notAccepted);
    expect(await snapshot()).toEqual(before);
  });

  it.each(NAMES)("%s refuses an API-key session with 403", async (name) => {
    const headers = withHeader(w.customer.headers, "x-api-key", "key-123");
    await expect(endpoints[name](headers)).rejects.toEqual(notAccepted);
  });

  it.each(NAMES)(
    "%s asks with kind customer and accepts a cookie session",
    async (name) => {
      await expect(endpoints[name](w.customer.headers)).resolves.toBeTruthy();
      expect(seen.length).toBeGreaterThan(0);
      for (const input of seen) {
        expect(input.kind).toBe("customer");
        expect(input.session.user.id).toBe(w.customer.user.id);
        expect(input.headers).toBeInstanceOf(Headers);
      }
    },
  );
});

describe("no session", () => {
  beforeEach(() => setup());

  it.each(NAMES)("%s answers 401", async (name) => {
    const before = await snapshot();
    await expect(endpoints[name](new Headers())).rejects.toEqual(unauthorized);
    expect(await snapshot()).toEqual(before);
  });
});
