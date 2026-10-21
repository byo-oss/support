import { beforeAll, describe, expect, it } from "vitest";
import { authRuntime } from "./adapter";
import { SUPPORT_ERROR_CODES } from "./error-codes";
import type {
  SupportAcceptSessionInput,
  SupportAuthorizeInput,
  SupportOptions,
} from "./options";
import type {
  SupportAttachmentRow,
  SupportCannedReplyRow,
  SupportMessageRow,
} from "./schema";
import type { SupportAction } from "./statements";
import {
  createTestAuth,
  getContext,
  impersonatedHeaders,
  STAFF_ORG_ID,
  seedSupportWorld,
  type TestAuth,
} from "./test-utils";
import { memoryStorage } from "./testing/storage";
import { createTicket } from "./tickets";

const BASE = "http://localhost:3000/api/auth";

/** A raw upload request carrying the caller's headers (cookie included). */
function uploadRequest(path: string, headers: Headers): Request {
  const bytes = new TextEncoder().encode("hello, file");
  const withBody = new Headers(headers);
  withBody.set("content-type", "text/plain");
  withBody.set("content-length", String(bytes.byteLength));
  return new Request(`${BASE}${path}`, {
    method: "POST",
    body: bytes,
    headers: withBody,
  });
}

/**
 * Endpoints handed a `request` answer as a `Response`, and downloads always
 * do. This reads a JSON answer as the JSON endpoints return it and turns an
 * error answer into the rejection they throw (`{ status, body }`), so one
 * assertion fits every endpoint. A served file stays a `Response`.
 */
async function settle(result: unknown): Promise<unknown> {
  if (!(result instanceof Response)) return result;
  if (!result.ok) {
    throw { status: result.statusText, body: await result.json() };
  }
  const type = result.headers.get("content-type") ?? "";
  return type.startsWith("application/json") ? result.json() : result;
}

type Target = {
  auth: TestAuth;
  ticketId: string;
  cannedId: string;
  attachmentId: string;
  /** A new ticket of the same requester and org, so each merge/delete call has its own. */
  freshTicket: () => Promise<string>;
};

async function setup(opts: SupportOptions = {}) {
  const storage = memoryStorage();
  const auth = createTestAuth({
    staffOrganizationId: STAFF_ORG_ID,
    attachments: { storage },
    ...opts,
  });
  const world = await seedSupportWorld(auth);
  const rt = await authRuntime(auth, "session-agent.test");
  const freshTicket = async () => {
    const { ticket } = await createTicket(rt, {
      subject: "Help",
      body: "Hi",
      channel: "web",
      userId: world.customer.user.id,
      organizationId: world.customerOrg.id,
      verified: true,
      actorId: world.customer.user.id,
    });
    return ticket.id;
  };
  const ticketId = await freshTicket();
  const { adapter } = await getContext(auth);
  const now = new Date();
  const canned = await adapter.create<
    Omit<SupportCannedReplyRow, "id">,
    SupportCannedReplyRow
  >({
    model: "supportCannedReply",
    data: { title: "Seed", body: "Seed", createdAt: now, updatedAt: now },
  });
  const attachment = await adapter.create<
    Omit<SupportAttachmentRow, "id">,
    SupportAttachmentRow
  >({
    model: "supportAttachment",
    data: {
      ticketId,
      messageId: null,
      userId: world.agents.owner.user.id,
      internal: false,
      filename: "seed.txt",
      contentType: "text/plain",
      size: 4,
      storageKey: "seed/seed.txt",
      createdAt: now,
    },
  });
  await storage.put({
    key: "seed/seed.txt",
    body: new TextEncoder().encode("seed"),
    contentType: "text/plain",
  });
  const target: Target = {
    auth,
    ticketId,
    cannedId: canned.id,
    attachmentId: attachment.id,
    freshTicket,
  };
  return { auth, world, rt, target };
}

type EndpointCase = {
  name: string;
  action: SupportAction;
  call: (target: Target, headers: Headers) => Promise<unknown>;
};

// every agent endpoint N08 owns, with the one action its gate asks for
const ENDPOINTS: EndpointCase[] = [
  {
    name: "listSupportTickets",
    action: "read",
    call: ({ auth }, headers) =>
      auth.api.listSupportTickets({ query: {}, headers }),
  },
  {
    name: "getSupportTicketAsAgent",
    action: "read",
    call: ({ auth, ticketId }, headers) =>
      auth.api.getSupportTicketAsAgent({ query: { id: ticketId }, headers }),
  },
  {
    name: "replyAsSupportAgent",
    action: "reply",
    call: ({ auth, ticketId }, headers) =>
      auth.api.replyAsSupportAgent({
        body: { ticketId, body: "On it" },
        headers,
      }),
  },
  {
    name: "updateSupportTickets",
    action: "update",
    call: ({ auth, ticketId }, headers) =>
      auth.api.updateSupportTickets({
        body: { ids: [ticketId], priority: "high" },
        headers,
      }),
  },
  {
    name: "markSupportTicketSeenAsAgent",
    action: "read",
    call: ({ auth, ticketId }, headers) =>
      auth.api.markSupportTicketSeenAsAgent({
        body: { id: ticketId },
        headers,
      }),
  },
  {
    name: "listSupportTags",
    action: "read",
    call: ({ auth }, headers) => auth.api.listSupportTags({ headers }),
  },
  {
    name: "listSupportCannedReplies",
    action: "read",
    call: ({ auth }, headers) =>
      auth.api.listSupportCannedReplies({ query: {}, headers }),
  },
  {
    name: "saveSupportCannedReply",
    action: "manage",
    call: ({ auth }, headers) =>
      auth.api.saveSupportCannedReply({
        body: { title: "Thanks", body: "Thanks for writing in." },
        headers,
      }),
  },
  {
    name: "deleteSupportCannedReply",
    action: "manage",
    call: ({ auth, cannedId }, headers) =>
      auth.api.deleteSupportCannedReply({ body: { id: cannedId }, headers }),
  },
  {
    name: "mergeSupportTickets",
    action: "update",
    call: async ({ auth, freshTicket }, headers) => {
      const [sourceId, targetId] = [await freshTicket(), await freshTicket()];
      return auth.api.mergeSupportTickets({
        body: { sourceId, targetId },
        headers,
      });
    },
  },
  {
    name: "deleteSupportTickets",
    action: "delete",
    call: async ({ auth, freshTicket }, headers) =>
      auth.api.deleteSupportTickets({
        body: { ids: [await freshTicket()] },
        headers,
      }),
  },
  {
    name: "uploadSupportAttachmentAsAgent",
    action: "reply",
    call: async ({ auth, ticketId }, headers) =>
      settle(
        await auth.api.uploadSupportAttachmentAsAgent({
          query: { ticketId, filename: "notes.txt" },
          headers,
          request: uploadRequest("/support/agent/upload", headers),
        }),
      ),
  },
  {
    name: "getSupportAttachmentAsAgent",
    action: "read",
    call: async ({ auth, attachmentId }, headers) => {
      const res = await settle(
        await auth.api.getSupportAttachmentAsAgent({
          query: { id: attachmentId },
          headers,
        }),
      );
      // the served file itself
      expect(res).toBeInstanceOf(Response);
      expect(await (res as Response).text()).toBe("seed");
      return res;
    },
  },
];

const notAccepted = expect.objectContaining({
  status: "FORBIDDEN",
  body: expect.objectContaining({
    code: SUPPORT_ERROR_CODES.SESSION_NOT_ACCEPTED.code,
  }),
});

const notAllowed = expect.objectContaining({
  status: "FORBIDDEN",
  body: expect.objectContaining({ code: SUPPORT_ERROR_CODES.NOT_ALLOWED.code }),
});

describe("default acceptSession: impersonated sessions (PRD #7, agent half)", () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => {
    s = await setup();
  });

  for (const endpoint of ENDPOINTS) {
    it(`${endpoint.name} (support:${endpoint.action}) refuses an impersonated owner session`, async () => {
      const headers = await impersonatedHeaders(
        s.auth,
        s.world.agents.owner.user.email,
        s.world.agents.admin.user.id,
      );
      await expect(endpoint.call(s.target, headers)).rejects.toEqual(
        notAccepted,
      );
      // the same person, not impersonated, is let through
      await expect(
        endpoint.call(s.target, s.world.agents.owner.headers),
      ).resolves.toBeTruthy();
    });
  }

  it("an impersonated reply writes nothing", async () => {
    const before = await s.rt.adapter.findMany<SupportMessageRow>({
      model: "supportMessage",
      where: [{ field: "ticketId", value: s.target.ticketId }],
      limit: 1000,
    });
    const headers = await impersonatedHeaders(
      s.auth,
      s.world.agents.admin.user.email,
    );
    await expect(
      s.auth.api.replyAsSupportAgent({
        body: { ticketId: s.target.ticketId, body: "As someone else" },
        headers,
      }),
    ).rejects.toEqual(notAccepted);
    const after = await s.rt.adapter.findMany<SupportMessageRow>({
      model: "supportMessage",
      where: [{ field: "ticketId", value: s.target.ticketId }],
      limit: 1000,
    });
    expect(after).toHaveLength(before.length);
  });
});

describe("an app acceptSession refusing bearer and API-key style sessions", () => {
  const seen: SupportAcceptSessionInput[] = [];
  let s: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => {
    s = await setup({
      acceptSession: (input) => {
        seen.push(input);
        if (input.session.session.impersonatedBy) return false;
        const auth = input.headers.get("authorization") ?? "";
        return !/^bearer\s/i.test(auth) && !input.headers.has("x-api-key");
      },
    });
  });

  const withHeader = (base: Headers, name: string, value: string) => {
    const headers = new Headers(base);
    headers.set(name, value);
    return headers;
  };

  for (const endpoint of ENDPOINTS) {
    it(`${endpoint.name}: 403 SESSION_NOT_ACCEPTED for bearer and API-key requests, allowed otherwise`, async () => {
      const cookie = s.world.agents.owner.headers;
      seen.length = 0;
      await expect(
        endpoint.call(
          s.target,
          withHeader(cookie, "authorization", "Bearer abc.def"),
        ),
      ).rejects.toEqual(notAccepted);
      await expect(
        endpoint.call(s.target, withHeader(cookie, "x-api-key", "key_123")),
      ).rejects.toEqual(notAccepted);
      expect(seen.map((input) => input.kind)).toEqual(["agent", "agent"]);
      expect(seen[0]?.session.user.id).toBe(s.world.agents.owner.user.id);
      await expect(endpoint.call(s.target, cookie)).resolves.toBeTruthy();
    });
  }
});

describe("custom authorize receives the staff org and the endpoint's action", () => {
  const calls: SupportAuthorizeInput[] = [];
  let allow = true;
  let s: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => {
    s = await setup({
      authorize: (input) => {
        calls.push(input);
        return allow;
      },
    });
  });

  for (const endpoint of ENDPOINTS) {
    it(`${endpoint.name} asks for exactly { support: ["${endpoint.action}"] } in the staff org`, async () => {
      allow = true;
      calls.length = 0;
      // the custom authorize decides alone: even a customer passes when it says yes
      const caller = s.world.customer;
      await expect(
        endpoint.call(s.target, caller.headers),
      ).resolves.toBeTruthy();
      expect(calls).toHaveLength(1);
      const [input] = calls;
      expect(input?.organizationId).toBe(STAFF_ORG_ID);
      expect(input?.permissions).toEqual({ support: [endpoint.action] });
      expect(input?.session.user.id).toBe(caller.user.id);
      expect(input?.headers).toBeInstanceOf(Headers);
      expect(input?.headers.get("cookie")).toBe(caller.headers.get("cookie"));

      allow = false;
      await expect(
        endpoint.call(s.target, s.world.agents.owner.headers),
      ).rejects.toEqual(notAllowed);
    });
  }
});
