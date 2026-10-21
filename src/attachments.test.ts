import { describe, expect, it, vi } from "vitest";
import { authRuntime, findAll } from "./adapter";
import { pruneUploads, storeInboundPart } from "./attachments";
import { SUPPORT_ERROR_CODES } from "./error-codes";
import { support } from "./index";
import type { SupportOptions, SupportStorage } from "./options";
import type {
  SupportAttachmentRow,
  SupportMessageRow,
  SupportTicketRow,
} from "./schema";
import {
  createTestAuth,
  getContext,
  STAFF_ORG_ID,
  STAFF_ORG_UUID,
  type SupportTestWorld,
  seedSupportWorld,
  type TestAuth,
  type TestUser,
} from "./test-utils";
import { type MemoryStorage, memoryStorage } from "./testing/storage";

// `merge.ts` belongs to another node and is still the identity here. A
// minimal resolver (follow `mergedIntoId`, at most 10 hops) stands in so the
// upload's merge-follow rule (D2) is exercised; only the merge tests set
// `mergedIntoId`, so every other test sees the identity.
vi.mock("./merge", () => ({
  resolveMergedTicket: async (
    adapter: import("better-auth").DBTransactionAdapter,
    ticket: import("./schema").SupportTicketRow,
  ) => {
    let current = ticket;
    for (let hop = 0; hop < 10 && current.mergedIntoId; hop++) {
      const next = await adapter.findOne<import("./schema").SupportTicketRow>({
        model: "supportTicket",
        where: [{ field: "id", value: current.mergedIntoId }],
      });
      if (!next) break;
      current = next;
    }
    return current;
  },
}));

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Setup = {
  auth: TestAuth;
  w: SupportTestWorld;
  storage: MemoryStorage;
};

async function setup(
  attachments: Partial<NonNullable<SupportOptions["attachments"]>> | false = {},
  extra: Partial<SupportOptions> = {},
): Promise<Setup> {
  const storage = memoryStorage();
  const auth = createTestAuth({
    staffOrganizationId: STAFF_ORG_ID,
    ...(attachments === false
      ? {}
      : { attachments: { storage, ...attachments } }),
    ...extra,
  });
  const w = await seedSupportWorld(auth);
  return { auth, w, storage };
}

const BASE = "http://localhost:3000/api/auth";
const encode = (s: string) => new TextEncoder().encode(s);

type UploadInput = {
  ticketId: string;
  filename?: string;
  body?: Uint8Array | string;
  type?: string | null;
  /** The declared `Content-Length`; `null` sends none. Default: the body's length. */
  length?: number | string | null;
  /** Agent upload; `internal` is sent as the query flag. */
  agent?: boolean;
  internal?: boolean;
};

/** POSTs a raw body through `auth.api.upload*` (with `request`), as a `Response`. */
function upload(s: Setup, user: TestUser, input: UploadInput) {
  const bytes =
    typeof input.body === "string"
      ? encode(input.body)
      : (input.body ?? encode("hello, file"));
  const headers = new Headers(user.headers);
  const type = input.type === undefined ? "text/plain" : input.type;
  if (type !== null) headers.set("content-type", type);
  const length = input.length === undefined ? bytes.byteLength : input.length;
  if (length !== null) headers.set("content-length", String(length));
  const path = input.agent ? "/support/agent/upload" : "/support/upload";
  const request = new Request(`${BASE}${path}`, {
    method: "POST",
    body: bytes as Uint8Array<ArrayBuffer>,
    headers,
  });
  const filename = input.filename ?? "notes.txt";
  if (input.agent) {
    return s.auth.api.uploadSupportAttachmentAsAgent({
      query: {
        ticketId: input.ticketId,
        filename,
        ...(input.internal !== undefined
          ? { internal: input.internal ? "true" : "false" }
          : {}),
      },
      headers: user.headers,
      request,
      asResponse: true,
    }) as Promise<Response>;
  }
  return s.auth.api.uploadSupportAttachment({
    query: { ticketId: input.ticketId, filename },
    headers: user.headers,
    request,
    asResponse: true,
  }) as Promise<Response>;
}

type UploadedAttachment = {
  id: string;
  ticketId: string;
  messageId: string | null;
  filename: string;
  contentType: string;
  size: number;
  internal?: boolean;
  createdAt: string;
};

/** An upload that must succeed: its `attachment`. */
async function uploaded(
  s: Setup,
  user: TestUser,
  input: UploadInput,
): Promise<UploadedAttachment> {
  const res = await upload(s, user, input);
  if (res.status !== 200) {
    throw new Error(`upload failed: ${res.status} ${await res.text()}`);
  }
  return ((await res.json()) as { attachment: UploadedAttachment }).attachment;
}

const download = (s: Setup, user: TestUser, id: string, agent = false) =>
  (agent
    ? s.auth.api.getSupportAttachmentAsAgent({
        query: { id },
        headers: user.headers,
        asResponse: true,
      })
    : s.auth.api.getSupportAttachment({
        query: { id },
        headers: user.headers,
        asResponse: true,
      })) as Promise<Response>;

async function expectError(
  res: Response,
  status: number,
  code: { code: string },
) {
  expect(res.status).toBe(status);
  expect(await res.json()).toMatchObject({ code: code.code });
}

const createTicket = (
  s: Setup,
  user: TestUser,
  body: {
    organizationId?: string;
    visibility?: "private" | "organization";
  } = {},
) =>
  s.auth.api.createSupportTicket({
    body: { subject: "Help", body: "It broke", ...body },
    headers: user.headers,
  });

const sharedTicket = (s: Setup) =>
  createTicket(s, s.w.customer, {
    organizationId: s.w.customerOrg.id,
    visibility: "organization",
  });

const reply = (
  s: Setup,
  user: TestUser,
  ticketId: string,
  attachmentIds: string[],
) =>
  s.auth.api.replyToSupportTicket({
    body: { ticketId, body: "See attached", attachmentIds },
    headers: user.headers,
  });

const agentReply = (
  s: Setup,
  ticketId: string,
  attachmentIds: string[],
  internal = false,
  agent: TestUser = s.w.agents.member,
) =>
  s.auth.api.replyAsSupportAgent({
    body: { ticketId, body: "Here you go", internal, attachmentIds },
    headers: agent.headers,
  });

const rejects = (status: string, code: { code: string }) =>
  expect.objectContaining({
    status,
    body: expect.objectContaining({ code: code.code }),
  });

const notUsable = rejects(
  "BAD_REQUEST",
  SUPPORT_ERROR_CODES.ATTACHMENT_NOT_USABLE,
);

async function rows(s: Setup): Promise<SupportAttachmentRow[]> {
  const { adapter } = await getContext(s.auth);
  return findAll<SupportAttachmentRow>(adapter, {
    model: "supportAttachment",
    where: [],
    max: 10_000,
  });
}

async function rowOf(s: Setup, id: string): Promise<SupportAttachmentRow> {
  const found = (await rows(s)).find((row) => row.id === id);
  if (!found) throw new Error(`no attachment ${id}`);
  return found;
}

async function messagesOf(
  s: Setup,
  ticketId: string,
): Promise<SupportMessageRow[]> {
  const { adapter } = await getContext(s.auth);
  return findAll<SupportMessageRow>(adapter, {
    model: "supportMessage",
    where: [{ field: "ticketId", value: ticketId }],
    max: 10_000,
  });
}

async function updateRow(
  s: Setup,
  model: string,
  id: string,
  update: Record<string, unknown>,
) {
  const { adapter } = await getContext(s.auth);
  await adapter.update({ model, where: [{ field: "id", value: id }], update });
}

// ---------------------------------------------------------------------------
// Setup and features
// ---------------------------------------------------------------------------

describe("attachments option", () => {
  it("creates no supportAttachment table without attachments, and the endpoints answer STORAGE_NOT_CONFIGURED", async () => {
    const s = await setup(false);
    const context = await getContext(s.auth);
    expect(Object.keys(context.tables)).not.toContain("supportAttachment");
    const { ticket } = await createTicket(s, s.w.customer);
    await expectError(
      await upload(s, s.w.customer, { ticketId: ticket.id }),
      400,
      SUPPORT_ERROR_CODES.STORAGE_NOT_CONFIGURED,
    );
    await expectError(
      await upload(s, s.w.agents.member, { ticketId: ticket.id, agent: true }),
      400,
      SUPPORT_ERROR_CODES.STORAGE_NOT_CONFIGURED,
    );
    await expectError(
      await download(s, s.w.customer, "any"),
      400,
      SUPPORT_ERROR_CODES.STORAGE_NOT_CONFIGURED,
    );
    await expectError(
      await download(s, s.w.agents.member, "any", true),
      400,
      SUPPORT_ERROR_CODES.STORAGE_NOT_CONFIGURED,
    );
    // reads and the sweep never touch the missing table
    const detail = await s.auth.api.getSupportTicket({
      query: { id: ticket.id },
      headers: s.w.customer.headers,
    });
    expect(detail.attachments).toEqual([]);
    expect(await pruneUploads(await authRuntime(s.auth, "t"), new Date())).toBe(
      0,
    );
    expect((await s.auth.api.processSupportDeliveries()).pruned).toBe(0);
  });

  it("creates the table with attachments and reports features.attachments true", async () => {
    const s = await setup();
    const context = await getContext(s.auth);
    expect(Object.keys(context.tables)).toContain("supportAttachment");
    const mine = await s.auth.api.listMySupportTickets({
      query: {},
      headers: s.w.customer.headers,
    });
    expect(mine.features).toEqual({ attachments: true });
    const queue = await s.auth.api.listSupportTickets({
      query: {},
      headers: s.w.agents.member.headers,
    });
    expect(queue.features).toEqual({ attachments: true, merge: true });
  });

  it("refuses HTML, SVG and XHTML in allowedTypes at boot", () => {
    const storage = memoryStorage();
    for (const type of [
      "text/html",
      "image/svg+xml",
      "application/xhtml+xml",
      "Text/HTML; charset=utf-8",
      " IMAGE/SVG+XML ",
    ]) {
      expect(() =>
        support({
          attachments: { storage, allowedTypes: ["image/png", type] },
        }),
      ).toThrow(
        /^\[@byo-oss\/support\] attachments\.allowedTypes can't include/,
      );
    }
    expect(() =>
      support({ attachments: { storage, allowedTypes: ["image/png"] } }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Upload limits
// ---------------------------------------------------------------------------

describe("upload limits", () => {
  it("stores a valid upload and returns it unattached", async () => {
    const s = await setup();
    const { ticket } = await createTicket(s, s.w.customer);
    const res = await upload(s, s.w.customer, {
      ticketId: ticket.id,
      body: "a,b\n1,2\n",
      type: "Text/CSV; charset=utf-8",
      filename: "data.csv",
    });
    expect(res.status).toBe(200);
    const { attachment } = (await res.json()) as {
      attachment: UploadedAttachment;
    };
    expect(attachment).toEqual({
      id: expect.any(String),
      ticketId: ticket.id,
      messageId: null,
      filename: "data.csv",
      contentType: "text/csv",
      size: 8,
      createdAt: expect.any(String),
    });
    const row = await rowOf(s, attachment.id);
    expect(row).toMatchObject({
      userId: s.w.customer.user.id,
      internal: false,
      storageKey: `support/_/${attachment.id}`,
    });
    expect(s.storage.keys).toEqual([`support/_/${attachment.id}`]);
  });

  it("answers 413 for a missing, malformed or over-limit Content-Length, without storing anything", async () => {
    const s = await setup({ maxBytes: 16 });
    const { ticket } = await createTicket(s, s.w.customer);
    for (const length of [null, "", "abc", "-1", "1.5", 17, 10_000_000]) {
      await expectError(
        await upload(s, s.w.customer, {
          ticketId: ticket.id,
          body: "x".repeat(8),
          length,
        }),
        413,
        SUPPORT_ERROR_CODES.ATTACHMENT_TOO_LARGE,
      );
    }
    // exactly at the limit is fine
    expect(
      (
        await upload(s, s.w.customer, {
          ticketId: ticket.id,
          body: "x".repeat(16),
        })
      ).status,
    ).toBe(200);
    expect(await rows(s)).toHaveLength(1);
    expect(s.storage.keys).toHaveLength(1);
  });

  it("counts the bytes read, so a body longer than its Content-Length is refused", async () => {
    const s = await setup({ maxBytes: 16 });
    const { ticket } = await createTicket(s, s.w.customer);
    // declared within the limit, body past it
    await expectError(
      await upload(s, s.w.customer, {
        ticketId: ticket.id,
        body: "y".repeat(64),
        length: 16,
      }),
      413,
      SUPPORT_ERROR_CODES.ATTACHMENT_TOO_LARGE,
    );
    // declared smaller than the body, both under the limit: still a lie
    await expectError(
      await upload(s, s.w.customer, {
        ticketId: ticket.id,
        body: "y".repeat(12),
        length: 4,
      }),
      413,
      SUPPORT_ERROR_CODES.ATTACHMENT_TOO_LARGE,
    );
    expect(await rows(s)).toEqual([]);
    expect(s.storage.keys).toEqual([]);
  });

  it("refuses a type outside allowedTypes with 415, HTML and SVG included", async () => {
    const s = await setup({ allowedTypes: ["image/png", "text/plain"] });
    const { ticket } = await createTicket(s, s.w.customer);
    for (const type of [
      "application/pdf",
      "text/html",
      "image/svg+xml",
      "application/xhtml+xml",
      "application/octet-stream",
      "",
      null,
    ]) {
      await expectError(
        await upload(s, s.w.customer, { ticketId: ticket.id, type }),
        415,
        SUPPORT_ERROR_CODES.ATTACHMENT_TYPE_NOT_ALLOWED,
      );
    }
    expect(
      (
        await upload(s, s.w.customer, {
          ticketId: ticket.id,
          type: "IMAGE/PNG",
        })
      ).status,
    ).toBe(200);
    expect(await rows(s)).toHaveLength(1);
  });

  it("uses the default allow-list", async () => {
    const s = await setup();
    const { ticket } = await createTicket(s, s.w.customer);
    for (const type of [
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "application/pdf",
      "text/plain",
      "text/csv",
      "application/zip",
    ]) {
      expect(
        (await upload(s, s.w.customer, { ticketId: ticket.id, type })).status,
      ).toBe(200);
    }
    await expectError(
      await upload(s, s.w.customer, { ticketId: ticket.id, type: "text/html" }),
      415,
      SUPPORT_ERROR_CODES.ATTACHMENT_TYPE_NOT_ALLOWED,
    );
  });

  it("sanitizes the filename: no path parts, at most 200 characters", async () => {
    const s = await setup();
    const { ticket } = await createTicket(s, s.w.customer);
    const a = await uploaded(s, s.w.customer, {
      ticketId: ticket.id,
      filename: "../../etc/passwd.txt",
    });
    expect(a.filename).toBe("passwd.txt");
    const b = await uploaded(s, s.w.customer, {
      ticketId: ticket.id,
      filename: "C:\\Users\\me\\report.txt",
    });
    expect(b.filename).toBe("report.txt");
    const c = await uploaded(s, s.w.customer, {
      ticketId: ticket.id,
      filename: `${"n".repeat(300)}.txt`,
    });
    expect(c.filename).toHaveLength(200);
    const d = await uploaded(s, s.w.customer, {
      ticketId: ticket.id,
      filename: "dir/ ",
    });
    expect(d.filename).toBe("attachment");
  });

  it("checks the ticket before the body: a non-member gets 404, never 413", async () => {
    const s = await setup();
    const { ticket } = await createTicket(s, s.w.customer);
    const res = await upload(s, s.w.outsider, {
      ticketId: ticket.id,
      length: null,
    });
    await expectError(res, 404, SUPPORT_ERROR_CODES.TICKET_NOT_FOUND);
    await expectError(
      await upload(s, s.w.agents.member, {
        ticketId: "missing",
        agent: true,
      }),
      404,
      SUPPORT_ERROR_CODES.TICKET_NOT_FOUND,
    );
  });

  it("needs a session, and support:reply for agent uploads", async () => {
    const s = await setup();
    const { ticket } = await createTicket(s, s.w.customer);
    const anonymous = { user: s.w.customer.user, headers: new Headers() };
    expect((await upload(s, anonymous, { ticketId: ticket.id })).status).toBe(
      401,
    );
    await expectError(
      await upload(s, s.w.agents.lacksReply, {
        ticketId: ticket.id,
        agent: true,
      }),
      403,
      SUPPORT_ERROR_CODES.NOT_ALLOWED,
    );
    await expectError(
      await upload(s, s.w.customer, { ticketId: ticket.id, agent: true }),
      403,
      SUPPORT_ERROR_CODES.NOT_ALLOWED,
    );
  });

  it("removes the row again when storage.put fails", async () => {
    const storage = memoryStorage();
    const failing: SupportStorage = {
      ...storage,
      put: async () => {
        throw new Error("bucket gone");
      },
    };
    const s = await setup({ storage: failing });
    const { ticket } = await createTicket(s, s.w.customer);
    // the storage error fails the request (a 500 over HTTP)
    await expect(
      upload(s, s.w.customer, { ticketId: ticket.id }),
    ).rejects.toThrow("bucket gone");
    expect(await rows(s)).toEqual([]);
  });

  it("works with uuid ids: the row id is the key's last part", async () => {
    const storage = memoryStorage();
    const auth = createTestAuth(
      { staffOrganizationId: STAFF_ORG_UUID, attachments: { storage } },
      { authOptions: { advanced: { database: { generateId: "uuid" } } } },
    );
    const w = await seedSupportWorld(auth);
    const s: Setup = { auth, w, storage };
    const { ticket } = await createTicket(s, w.customer);
    const a = await uploaded(s, w.customer, { ticketId: ticket.id });
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await rowOf(s, a.id)).storageKey).toBe(`support/_/${a.id}`);
    expect(storage.keys).toEqual([`support/_/${a.id}`]);
  });
});

// ---------------------------------------------------------------------------
// Binding
// ---------------------------------------------------------------------------

describe("binding attachments to messages", () => {
  it("binds the caller's unattached uploads on the same ticket to the reply", async () => {
    const s = await setup();
    const { ticket } = await createTicket(s, s.w.customer);
    const a = await uploaded(s, s.w.customer, { ticketId: ticket.id });
    const b = await uploaded(s, s.w.customer, { ticketId: ticket.id });
    const { message } = await reply(s, s.w.customer, ticket.id, [
      a.id,
      b.id,
      a.id,
    ]);
    expect((await rowOf(s, a.id)).messageId).toBe(message.id);
    expect((await rowOf(s, b.id)).messageId).toBe(message.id);
    const detail = await s.auth.api.getSupportTicket({
      query: { id: ticket.id },
      headers: s.w.customer.headers,
    });
    expect(detail.attachments.map((x) => x.id).sort()).toEqual(
      [a.id, b.id].sort(),
    );
    expect(detail.attachments[0]).toEqual({
      id: expect.any(String),
      ticketId: ticket.id,
      messageId: message.id,
      filename: "notes.txt",
      contentType: "text/plain",
      size: 11,
      createdAt: expect.any(Date),
    });
  });

  it("refuses an upload from another ticket, by someone else, already attached, or unknown, writing nothing", async () => {
    const s = await setup();
    const { ticket } = await sharedTicket(s);
    const { ticket: other } = await createTicket(s, s.w.customer);
    const elsewhere = await uploaded(s, s.w.customer, { ticketId: other.id });
    const byTeammate = await uploaded(s, s.w.teammate, { ticketId: ticket.id });
    const used = await uploaded(s, s.w.customer, { ticketId: ticket.id });
    await reply(s, s.w.customer, ticket.id, [used.id]);
    const before = (await messagesOf(s, ticket.id)).length;

    for (const ids of [
      [elsewhere.id],
      [byTeammate.id],
      [used.id],
      ["missing"],
    ]) {
      await expect(reply(s, s.w.customer, ticket.id, ids)).rejects.toEqual(
        notUsable,
      );
    }
    expect((await messagesOf(s, ticket.id)).length).toBe(before);
    expect((await rowOf(s, byTeammate.id)).messageId).toBeNull();
    expect((await rowOf(s, elsewhere.id)).messageId).toBeNull();
  });

  it("matches the audience exactly: internal uploads only on notes, public ones only on replies", async () => {
    const s = await setup();
    const { ticket } = await createTicket(s, s.w.customer);
    const internal = await uploaded(s, s.w.agents.member, {
      ticketId: ticket.id,
      agent: true,
      internal: true,
    });
    const external = await uploaded(s, s.w.agents.member, {
      ticketId: ticket.id,
      agent: true,
    });
    expect(internal.internal).toBe(true);
    expect(external.internal).toBe(false);

    await expect(
      agentReply(s, ticket.id, [internal.id], false),
    ).rejects.toEqual(notUsable);
    await expect(agentReply(s, ticket.id, [external.id], true)).rejects.toEqual(
      notUsable,
    );
    const note = await agentReply(s, ticket.id, [internal.id], true);
    const replyMessage = await agentReply(s, ticket.id, [external.id], false);
    expect((await rowOf(s, internal.id)).messageId).toBe(note.message.id);
    expect((await rowOf(s, external.id)).messageId).toBe(
      replyMessage.message.id,
    );
  });

  it("refuses a teammate's agent-side mix-up: an agent can't attach another agent's upload", async () => {
    const s = await setup();
    const { ticket } = await createTicket(s, s.w.customer);
    const mine = await uploaded(s, s.w.agents.member, {
      ticketId: ticket.id,
      agent: true,
    });
    await expect(
      agentReply(s, ticket.id, [mine.id], false, s.w.agents.admin),
    ).rejects.toEqual(notUsable);
  });
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

describe("reading attachments", () => {
  it("never shows customers internal files or files bound to notes; agents see all", async () => {
    const s = await setup();
    const { ticket } = await createTicket(s, s.w.customer);
    const internal = await uploaded(s, s.w.agents.member, {
      ticketId: ticket.id,
      agent: true,
      internal: true,
    });
    const external = await uploaded(s, s.w.agents.member, {
      ticketId: ticket.id,
      agent: true,
    });
    await agentReply(s, ticket.id, [internal.id], true);
    await agentReply(s, ticket.id, [external.id], false);

    const customerView = await s.auth.api.getSupportTicket({
      query: { id: ticket.id },
      headers: s.w.customer.headers,
    });
    expect(customerView.attachments.map((a) => a.id)).toEqual([external.id]);
    expect(customerView.attachments[0]).not.toHaveProperty("internal");
    expect(customerView.attachments[0]).not.toHaveProperty("storageKey");
    expect(customerView.attachments[0]).not.toHaveProperty("userId");

    const agentView = await s.auth.api.getSupportTicketAsAgent({
      query: { id: ticket.id },
      headers: s.w.agents.member.headers,
    });
    expect(agentView.attachments.map((a) => [a.id, a.internal])).toEqual([
      [internal.id, true],
      [external.id, false],
    ]);
    expect(agentView.attachments[0]).not.toHaveProperty("storageKey");

    await expectError(
      await download(s, s.w.customer, internal.id),
      404,
      SUPPORT_ERROR_CODES.ATTACHMENT_NOT_FOUND,
    );
    expect((await download(s, s.w.customer, external.id)).status).toBe(200);
    expect(
      (await download(s, s.w.agents.member, internal.id, true)).status,
    ).toBe(200);
  });

  it("hides a non-internal file bound to a note from customers (second guard)", async () => {
    const s = await setup();
    const { ticket } = await createTicket(s, s.w.customer);
    const internal = await uploaded(s, s.w.agents.member, {
      ticketId: ticket.id,
      agent: true,
      internal: true,
    });
    await agentReply(s, ticket.id, [internal.id], true);
    // a row whose flag is wrong: still bound to a note
    await updateRow(s, "supportAttachment", internal.id, { internal: false });

    const view = await s.auth.api.getSupportTicket({
      query: { id: ticket.id },
      headers: s.w.customer.headers,
    });
    expect(view.attachments).toEqual([]);
    await expectError(
      await download(s, s.w.customer, internal.id),
      404,
      SUPPORT_ERROR_CODES.ATTACHMENT_NOT_FOUND,
    );
  });

  it("lets a teammate upload and read on a shared ticket; a non-member gets 404", async () => {
    const s = await setup();
    const { ticket } = await sharedTicket(s);
    const file = await uploaded(s, s.w.teammate, {
      ticketId: ticket.id,
      body: "teammate file",
    });
    await reply(s, s.w.teammate, ticket.id, [file.id]);
    for (const user of [s.w.customer, s.w.teammate]) {
      const res = await download(s, user, file.id);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("teammate file");
    }
    await expectError(
      await download(s, s.w.outsider, file.id),
      404,
      SUPPORT_ERROR_CODES.ATTACHMENT_NOT_FOUND,
    );
    await expectError(
      await upload(s, s.w.outsider, { ticketId: ticket.id }),
      404,
      SUPPORT_ERROR_CODES.TICKET_NOT_FOUND,
    );
    // a private ticket: the teammate isn't in it
    const { ticket: mine } = await createTicket(s, s.w.customer);
    await expectError(
      await upload(s, s.w.teammate, { ticketId: mine.id }),
      404,
      SUPPORT_ERROR_CODES.TICKET_NOT_FOUND,
    );
  });

  it("serves an unattached upload only to its uploader and to agents", async () => {
    const s = await setup();
    const { ticket } = await sharedTicket(s);
    const file = await uploaded(s, s.w.customer, { ticketId: ticket.id });
    expect((await download(s, s.w.customer, file.id)).status).toBe(200);
    expect((await download(s, s.w.agents.member, file.id, true)).status).toBe(
      200,
    );
    for (const user of [s.w.teammate, s.w.outsider]) {
      await expectError(
        await download(s, user, file.id),
        404,
        SUPPORT_ERROR_CODES.ATTACHMENT_NOT_FOUND,
      );
    }
    // unattached files never appear in a ticket's list
    const agentView = await s.auth.api.getSupportTicketAsAgent({
      query: { id: ticket.id },
      headers: s.w.agents.member.headers,
    });
    expect(agentView.attachments).toEqual([]);
  });

  it("answers 404 for an unknown id, and needs support:read for agent downloads", async () => {
    const s = await setup();
    const { ticket } = await createTicket(s, s.w.customer);
    const file = await uploaded(s, s.w.customer, { ticketId: ticket.id });
    await expectError(
      await download(s, s.w.customer, "missing"),
      404,
      SUPPORT_ERROR_CODES.ATTACHMENT_NOT_FOUND,
    );
    await expectError(
      await download(s, s.w.agents.member, "missing", true),
      404,
      SUPPORT_ERROR_CODES.ATTACHMENT_NOT_FOUND,
    );
    await expectError(
      await download(s, s.w.agents.lacksRead, file.id, true),
      403,
      SUPPORT_ERROR_CODES.NOT_ALLOWED,
    );
    await expectError(
      await download(s, s.w.customer, file.id, true),
      403,
      SUPPORT_ERROR_CODES.NOT_ALLOWED,
    );
  });

  it("answers 404 when the blob is gone", async () => {
    const s = await setup();
    const { ticket } = await createTicket(s, s.w.customer);
    const file = await uploaded(s, s.w.customer, { ticketId: ticket.id });
    s.storage.clear();
    await expectError(
      await download(s, s.w.customer, file.id),
      404,
      SUPPORT_ERROR_CODES.ATTACHMENT_NOT_FOUND,
    );
  });
});

// ---------------------------------------------------------------------------
// Serving headers
// ---------------------------------------------------------------------------

describe("serving headers", () => {
  it("sends the download headers exactly, and the bytes", async () => {
    const s = await setup();
    const { ticket } = await createTicket(s, s.w.customer);
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0, 1, 2, 255]);
    const file = await uploaded(s, s.w.customer, {
      ticketId: ticket.id,
      body: bytes,
      type: "application/pdf",
      filename: "résumé (1)'s*.pdf",
    });
    for (const res of [
      await download(s, s.w.customer, file.id),
      await download(s, s.w.agents.member, file.id, true),
    ]) {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/pdf");
      expect(res.headers.get("content-disposition")).toBe(
        "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9%20%281%29%27s%2A.pdf",
      );
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("content-security-policy")).toBe("sandbox");
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("content-length")).toBe("8");
      expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual(
        Array.from(bytes),
      );
    }
  });

  it("sends the stored type only for png, jpeg, gif, webp and pdf", async () => {
    const s = await setup();
    const { ticket } = await createTicket(s, s.w.customer);
    const cases: [string, string][] = [
      ["image/png", "image/png"],
      ["image/jpeg", "image/jpeg"],
      ["image/gif", "image/gif"],
      ["image/webp", "image/webp"],
      ["application/pdf", "application/pdf"],
      ["text/plain", "application/octet-stream"],
      ["text/csv", "application/octet-stream"],
      ["application/zip", "application/octet-stream"],
    ];
    for (const [type, served] of cases) {
      const file = await uploaded(s, s.w.customer, {
        ticketId: ticket.id,
        type,
      });
      const res = await download(s, s.w.customer, file.id);
      expect(res.headers.get("content-type")).toBe(served);
    }
  });
});

// ---------------------------------------------------------------------------
// Merge following
// ---------------------------------------------------------------------------

describe("uploads follow mergedIntoId", () => {
  it("stores customer and agent uploads on the ticket the named one was merged into", async () => {
    const s = await setup();
    const { ticket: source } = await createTicket(s, s.w.customer);
    const { ticket: target } = await createTicket(s, s.w.customer);
    await updateRow(s, "supportTicket", source.id, {
      status: "closed",
      mergedIntoId: target.id,
    });
    const a = await uploaded(s, s.w.customer, { ticketId: source.id });
    const b = await uploaded(s, s.w.agents.member, {
      ticketId: source.id,
      agent: true,
    });
    expect(a.ticketId).toBe(target.id);
    expect(b.ticketId).toBe(target.id);
    // so a reply on the resolved ticket can attach them
    const { message } = await reply(s, s.w.customer, source.id, [a.id]);
    expect((await rowOf(s, a.id)).messageId).toBe(message.id);
  });

  it("re-applies the read rule to the resolved ticket", async () => {
    const s = await setup();
    const { ticket: source } = await sharedTicket(s);
    const { ticket: target } = await createTicket(s, s.w.customer);
    await updateRow(s, "supportTicket", source.id, {
      status: "closed",
      mergedIntoId: target.id,
    });
    // the teammate could see the shared source, not the private target
    await expectError(
      await upload(s, s.w.teammate, { ticketId: source.id }),
      404,
      SUPPORT_ERROR_CODES.TICKET_NOT_FOUND,
    );
  });

  it("keys a file on an organization's ticket under that organization", async () => {
    const s = await setup();
    const { ticket } = await sharedTicket(s);
    const file = await uploaded(s, s.w.customer, { ticketId: ticket.id });
    expect(s.storage.keys).toEqual([
      `support/${s.w.customerOrg.id}/${file.id}`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Pruning (through the sweep)
// ---------------------------------------------------------------------------

describe("pruning unattached uploads", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it("removes uploads unattached for more than 24 h, blob first, and keeps attached and fresh ones", async () => {
    const s = await setup();
    const { ticket } = await createTicket(s, s.w.customer);
    const stale = await uploaded(s, s.w.customer, { ticketId: ticket.id });
    const attached = await uploaded(s, s.w.customer, { ticketId: ticket.id });
    const fresh = await uploaded(s, s.w.customer, { ticketId: ticket.id });
    await reply(s, s.w.customer, ticket.id, [attached.id]);
    const old = new Date(Date.now() - DAY - 60_000);
    await updateRow(s, "supportAttachment", stale.id, { createdAt: old });
    await updateRow(s, "supportAttachment", attached.id, { createdAt: old });

    const result = await s.auth.api.processSupportDeliveries();
    expect(result.pruned).toBe(1);
    expect((await rows(s)).map((row) => row.id).sort()).toEqual(
      [attached.id, fresh.id].sort(),
    );
    expect(s.storage.keys).toEqual(
      [`support/_/${attached.id}`, `support/_/${fresh.id}`].sort(),
    );
    expect((await s.auth.api.processSupportDeliveries()).pruned).toBe(0);
  });

  it("keeps the row when its blob can't be deleted, and tries again next time", async () => {
    const storage = memoryStorage();
    let broken = true;
    const flaky: SupportStorage = {
      ...storage,
      put: (input) => storage.put(input),
      get: (key) => storage.get(key),
      deletePrefix: (prefix) => storage.deletePrefix(prefix),
      delete: async (key) => {
        if (broken) throw new Error("bucket gone");
        await storage.delete(key);
      },
    };
    const s = await setup({ storage: flaky });
    const { ticket } = await createTicket(s, s.w.customer);
    const a = await uploaded(s, s.w.customer, { ticketId: ticket.id });
    await updateRow(s, "supportAttachment", a.id, {
      createdAt: new Date(Date.now() - 2 * DAY),
    });
    const rt = await authRuntime(s.auth, "t");
    expect(await pruneUploads(rt, new Date())).toBe(0);
    expect(await rows(s)).toHaveLength(1);
    broken = false;
    expect(await pruneUploads(rt, new Date())).toBe(1);
    expect(await rows(s)).toEqual([]);
    expect(storage.keys).toEqual([]);
  });
  it("keeps an upload a reply binds between the sweep's read and its delete, with its blob", async () => {
    const s = await setup();
    const { ticket } = await createTicket(s, s.w.customer);
    const a = await uploaded(s, s.w.customer, { ticketId: ticket.id });
    const b = await uploaded(s, s.w.customer, { ticketId: ticket.id });
    for (const id of [a.id, b.id]) {
      await updateRow(s, "supportAttachment", id, {
        createdAt: new Date(Date.now() - 2 * DAY),
      });
    }
    const rt = await authRuntime(s.auth, "t");
    const { adapter } = rt;
    let bound = false;
    // `a` gets attached right after the sweep listed it as stale
    const racing: typeof adapter = Object.create(adapter);
    racing.findOne = async (query) => {
      if (!bound && query.model === "supportAttachment") {
        bound = true;
        await adapter.update({
          model: "supportAttachment",
          where: [{ field: "id", value: a.id }],
          update: { messageId: "msg-bound-meanwhile" },
        });
      }
      return adapter.findOne(query);
    };
    expect(await pruneUploads({ ...rt, adapter: racing }, new Date())).toBe(1);
    expect(bound).toBe(true);
    const left = await rows(s);
    expect(left.map((row) => [row.id, row.messageId])).toEqual([
      [a.id, "msg-bound-meanwhile"],
    ]);
    expect(s.storage.keys).toEqual([`support/_/${a.id}`]);
  });
});

// ---------------------------------------------------------------------------
// Inbound parts
// ---------------------------------------------------------------------------

describe("storeInboundPart", () => {
  async function inbound(
    attachments:
      | Partial<NonNullable<SupportOptions["attachments"]>>
      | false = {},
  ) {
    const s = await setup(attachments);
    const { ticket } = await sharedTicket(s);
    const [first] = await messagesOf(s, ticket.id);
    const rt = await authRuntime(s.auth, "t");
    const row = (await getContext(s.auth)).adapter.findOne<SupportTicketRow>({
      model: "supportTicket",
      where: [{ field: "id", value: ticket.id }],
    });
    return {
      s,
      rt,
      ticket: (await row) as SupportTicketRow,
      messageId: (first as SupportMessageRow).id,
    };
  }

  const part = (
    overrides: Partial<{
      filename: string | null;
      contentType: string;
      content: Uint8Array;
    }> = {},
  ) => ({
    filename: "logs/report.pdf",
    contentType: "Application/PDF; name=report.pdf",
    content: new Uint8Array([1, 2, 3, 4]),
    ...overrides,
  });

  it("stores an allowed part on the message: internal false, sanitized name, normalized type", async () => {
    const { s, rt, ticket, messageId } = await inbound();
    const result = await storeInboundPart(rt, {
      ticket,
      messageId,
      userId: s.w.customer.user.id,
      part: part(),
    });
    if (!("stored" in result)) throw new Error("not stored");
    expect(result.stored).toMatchObject({
      ticketId: ticket.id,
      messageId,
      userId: s.w.customer.user.id,
      internal: false,
      filename: "report.pdf",
      contentType: "application/pdf",
      size: 4,
      storageKey: `support/${s.w.customerOrg.id}/${result.stored.id}`,
    });
    expect(s.storage.keys).toEqual([result.stored.storageKey]);
    // attached to a reply, so the customer sees it
    const view = await s.auth.api.getSupportTicket({
      query: { id: ticket.id },
      headers: s.w.customer.headers,
    });
    expect(view.attachments.map((a) => a.id)).toEqual([result.stored.id]);
    const unnamed = await storeInboundPart(rt, {
      ticket,
      messageId,
      userId: null,
      part: part({ filename: null }),
    });
    expect("stored" in unnamed && unnamed.stored.filename).toBe("attachment");
  });

  it("drops parts over maxBytes or of a type not allowed", async () => {
    const { s, rt, ticket, messageId } = await inbound({ maxBytes: 3 });
    expect(
      await storeInboundPart(rt, {
        ticket,
        messageId,
        userId: null,
        part: part(),
      }),
    ).toEqual({ dropped: true, reason: "too_large" });
    for (const contentType of [
      "text/html",
      "image/svg+xml",
      "application/x-msdownload",
    ]) {
      expect(
        await storeInboundPart(rt, {
          ticket,
          messageId,
          userId: null,
          part: part({ contentType, content: new Uint8Array([1]) }),
        }),
      ).toEqual({ dropped: true, reason: "type_not_allowed" });
    }
    expect(await rows(s)).toEqual([]);
    expect(s.storage.keys).toEqual([]);
  });

  it("drops every part without attachments (no_storage)", async () => {
    const { rt, ticket, messageId } = await inbound(false);
    expect(
      await storeInboundPart(rt, {
        ticket,
        messageId,
        userId: null,
        part: part(),
      }),
    ).toEqual({ dropped: true, reason: "no_storage" });
  });

  it("reports storage_failed and leaves no row when put throws", async () => {
    const failing: SupportStorage = {
      ...memoryStorage(),
      put: async () => {
        throw new Error("bucket gone");
      },
    };
    const { s, rt, ticket, messageId } = await inbound({ storage: failing });
    expect(
      await storeInboundPart(rt, {
        ticket,
        messageId,
        userId: null,
        part: part(),
      }),
    ).toEqual({ dropped: true, reason: "storage_failed" });
    expect(await rows(s)).toEqual([]);
  });

  it("with serial ids, writes the row first, then the blob under the row's id, then the key", async () => {
    const { s, rt, ticket, messageId } = await inbound();
    const calls: string[] = [];
    const storage = s.storage;
    const serialRt = {
      ...rt,
      context: { ...rt.context, generateId: () => false as const },
      opts: {
        ...rt.opts,
        attachments: {
          ...(rt.opts.attachments as NonNullable<typeof rt.opts.attachments>),
          storage: {
            ...storage,
            put: async (input: Parameters<SupportStorage["put"]>[0]) => {
              const current = await rows(s);
              calls.push(
                `put ${input.key} rows=${current.length} key=${current[0]?.storageKey}`,
              );
              await storage.put(input);
            },
          },
        },
      },
    };
    const result = await storeInboundPart(serialRt, {
      ticket,
      messageId,
      userId: null,
      part: part(),
    });
    if (!("stored" in result)) throw new Error("not stored");
    const key = `support/${s.w.customerOrg.id}/${result.stored.id}`;
    expect(calls).toEqual([`put ${key} rows=1 key=`]);
    expect(result.stored.storageKey).toBe(key);
    expect((await rowOf(s, result.stored.id)).storageKey).toBe(key);
    expect(storage.keys).toEqual([key]);

    // and a failed put removes the row
    const failingRt = {
      ...serialRt,
      opts: {
        ...serialRt.opts,
        attachments: {
          ...serialRt.opts.attachments,
          storage: {
            ...storage,
            put: async () => {
              throw new Error("bucket gone");
            },
          },
        },
      },
    };
    expect(
      await storeInboundPart(failingRt, {
        ticket,
        messageId,
        userId: null,
        part: part(),
      }),
    ).toEqual({ dropped: true, reason: "storage_failed" });
    expect((await rows(s)).map((row) => row.id)).toEqual([result.stored.id]);
  });

  it("with string ids, creates the row with its final key before the put", async () => {
    const { s, rt, ticket, messageId } = await inbound();
    const seen: string[] = [];
    const storage = s.storage;
    const tracedRt = {
      ...rt,
      opts: {
        ...rt.opts,
        attachments: {
          ...(rt.opts.attachments as NonNullable<typeof rt.opts.attachments>),
          storage: {
            ...storage,
            put: async (input: Parameters<SupportStorage["put"]>[0]) => {
              const [row] = await rows(s);
              seen.push(`${row?.storageKey === input.key}`);
              await storage.put(input);
            },
          },
        },
      },
    };
    const result = await storeInboundPart(tracedRt, {
      ticket,
      messageId,
      userId: null,
      part: part(),
    });
    expect("stored" in result).toBe(true);
    expect(seen).toEqual(["true"]);
  });
});

// ---------------------------------------------------------------------------
// Over HTTP
// ---------------------------------------------------------------------------

describe("over HTTP (auth.handler)", () => {
  it("uploads a raw body with the query in the URL, then downloads it", async () => {
    const s = await setup();
    const { ticket } = await createTicket(s, s.w.customer);
    const headers = new Headers(s.w.customer.headers);
    headers.set("content-type", "image/png");
    headers.set("content-length", "4");
    headers.set("origin", "http://localhost:3000");
    const url = new URL(`${BASE}/support/upload`);
    url.searchParams.set("ticketId", ticket.id);
    url.searchParams.set("filename", "pixel.png");
    const res = await s.auth.handler(
      new Request(url, {
        method: "POST",
        body: new Uint8Array([137, 80, 78, 71]),
        headers,
      }),
    );
    expect(res.status).toBe(200);
    const { attachment } = (await res.json()) as {
      attachment: UploadedAttachment;
    };
    expect(attachment).toMatchObject({ filename: "pixel.png", size: 4 });

    const got = await s.auth.handler(
      new Request(`${BASE}/support/attachment?id=${attachment.id}`, {
        headers: s.w.customer.headers,
      }),
    );
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(Array.from(new Uint8Array(await got.arrayBuffer()))).toEqual([
      137, 80, 78, 71,
    ]);
  });
});
