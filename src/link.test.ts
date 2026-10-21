import { describe, expect, it, vi } from "vitest";
import { authRuntime, type SupportRuntime } from "./adapter";
import { linkSupportRequester, userLinkHooks } from "./link";
import type { SupportMessageRow, SupportTicketRow } from "./schema";
import {
  type AdapterCall,
  createTestAuth,
  getContext,
  insertMessage,
  insertTicket,
  signUpUser,
  verifyEmail,
} from "./test-utils";

const EMAIL = "pat@example.test";

async function setup() {
  const calls: AdapterCall[] = [];
  const auth = createTestAuth(
    {},
    { adapter: { before: (call) => void calls.push(call) } },
  );
  const rt = await authRuntime(auth, "link.test");
  return { auth, rt, calls };
}

/** An account-less email ticket from `EMAIL`, with its first message. */
async function seedEmailTicket(
  auth: Awaited<ReturnType<typeof setup>>["auth"],
  { verified = true }: { verified?: boolean } = {},
) {
  const ticket = await insertTicket(auth, {
    channel: "email",
    requesterEmail: EMAIL,
    requesterName: "Pat",
    verified,
  });
  const message = await insertMessage(auth, {
    ticketId: ticket.id,
    channel: "email",
    authorEmail: EMAIL,
    authorName: "Pat",
    verified,
  });
  return { ticket, message };
}

async function ticketRow(rt: SupportRuntime, id: string) {
  const row = await rt.adapter.findOne<SupportTicketRow>({
    model: "supportTicket",
    where: [{ field: "id", value: id }],
  });
  if (!row) throw new Error("ticket vanished");
  return row;
}

async function messageRow(rt: SupportRuntime, id: string) {
  const row = await rt.adapter.findOne<SupportMessageRow>({
    model: "supportMessage",
    where: [{ field: "id", value: id }],
  });
  if (!row) throw new Error("message vanished");
  return row;
}

describe("linking (PRD #11)", () => {
  it("links a verified email-only ticket on a verified sign-up with a mixed-case email (create.after)", async () => {
    const { auth, rt } = await setup();
    const { ticket, message } = await seedEmailTicket(auth);
    const context = await getContext(auth);
    // created already verified: only create.after runs
    const user = await context.internalAdapter.createUser({
      email: "  Pat@Example.TEST ",
      name: "Pat",
      emailVerified: true,
    });

    const linkedTicket = await ticketRow(rt, ticket.id);
    expect(linkedTicket.userId).toBe(user.id);
    expect(linkedTicket.requesterEmail ?? null).toBeNull();
    expect(linkedTicket.requesterName ?? null).toBeNull();
    const linkedMessage = await messageRow(rt, message.id);
    expect(linkedMessage.userId).toBe(user.id);
    expect(linkedMessage.authorEmail ?? null).toBeNull();
    expect(linkedMessage.authorName ?? null).toBeNull();
  });

  it("links when verification flips on later (update.after), mixed-case sign-up email", async () => {
    const { auth, rt } = await setup();
    const { ticket, message } = await seedEmailTicket(auth);
    const pat = await signUpUser(auth, "PAT@example.TEST");

    // signed up but unverified: nothing linked yet
    expect((await ticketRow(rt, ticket.id)).userId ?? null).toBeNull();
    expect((await ticketRow(rt, ticket.id)).requesterEmail).toBe(EMAIL);

    await verifyEmail(auth, pat.user.id);
    const linked = await ticketRow(rt, ticket.id);
    expect(linked.userId).toBe(pat.user.id);
    expect(linked.requesterEmail ?? null).toBeNull();
    expect((await messageRow(rt, message.id)).userId).toBe(pat.user.id);
  });

  it("doesn't link an unverified ticket or message on a verified sign-up", async () => {
    const { auth, rt } = await setup();
    const { ticket, message } = await seedEmailTicket(auth, {
      verified: false,
    });
    await signUpUser(auth, EMAIL, { verified: true });

    const row = await ticketRow(rt, ticket.id);
    expect(row.userId ?? null).toBeNull();
    expect(row.requesterEmail).toBe(EMAIL);
    expect(row.requesterName).toBe("Pat");
    const msg = await messageRow(rt, message.id);
    expect(msg.userId ?? null).toBeNull();
    expect(msg.authorEmail).toBe(EMAIL);
  });

  it("an unverified sign-up links nothing", async () => {
    const { auth, rt } = await setup();
    const { ticket, message } = await seedEmailTicket(auth);
    await signUpUser(auth, EMAIL);

    expect((await ticketRow(rt, ticket.id)).userId ?? null).toBeNull();
    expect((await ticketRow(rt, ticket.id)).requesterEmail).toBe(EMAIL);
    expect((await messageRow(rt, message.id)).userId ?? null).toBeNull();
  });

  it("an unverified ticket with a later verified append stays unlinked", async () => {
    const { auth, rt } = await setup();
    const { ticket, message } = await seedEmailTicket(auth, {
      verified: false,
    });
    const later = await insertMessage(auth, {
      ticketId: ticket.id,
      channel: "email",
      authorEmail: EMAIL,
      authorName: "Pat",
      verified: true,
    });
    const pat = await signUpUser(auth, EMAIL, { verified: true });

    const row = await ticketRow(rt, ticket.id);
    expect(row.userId ?? null).toBeNull();
    expect(row.requesterEmail).toBe(EMAIL);
    // the forged first message keeps its address; only the verified one links
    expect((await messageRow(rt, message.id)).userId ?? null).toBeNull();
    expect((await messageRow(rt, later.id)).userId).toBe(pat.user.id);
  });

  it("leaves other people's rows alone", async () => {
    const { auth, rt } = await setup();
    const other = await insertTicket(auth, {
      channel: "email",
      requesterEmail: "someone@example.test",
      verified: true,
    });
    await signUpUser(auth, EMAIL, { verified: true });
    const row = await ticketRow(rt, other.id);
    expect(row.userId ?? null).toBeNull();
    expect(row.requesterEmail).toBe("someone@example.test");
  });

  it("links more rows than one chunk", async () => {
    const { auth, rt } = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 95; i++) {
      ids.push((await seedEmailTicket(auth)).ticket.id);
    }
    const pat = await signUpUser(auth, EMAIL);
    const result = await linkSupportRequester(auth, pat.user.id);
    expect(result).toEqual({ tickets: 0, messages: 0 });

    await verifyEmail(auth, pat.user.id);
    const linked = await rt.adapter.count({
      model: "supportTicket",
      where: [{ field: "userId", value: pat.user.id }],
    });
    expect(linked).toBe(95);
    const linkedMessages = await rt.adapter.count({
      model: "supportMessage",
      where: [{ field: "userId", value: pat.user.id }],
    });
    expect(linkedMessages).toBe(95);
  });

  it("matches a mixed-case user email against the lowercased stored one", async () => {
    const { auth, rt } = await setup();
    const { ticket } = await seedEmailTicket(auth);
    const hooks = userLinkHooks(await getContext(auth), rt.opts);
    await hooks.create.after({
      id: "user_pat",
      email: "PAT@Example.Test",
      emailVerified: true,
      name: "Pat",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect((await ticketRow(rt, ticket.id)).userId).toBe("user_pat");
  });

  it("ignores a null update.after result without touching support tables", async () => {
    const { auth, rt, calls } = await setup();
    const context = await getContext(auth);
    const hooks = userLinkHooks(context, rt.opts);
    calls.length = 0;
    await expect(hooks.update.after(null)).resolves.toBeUndefined();
    await expect(hooks.create.after(null)).resolves.toBeUndefined();
    expect(calls.filter((c) => c.model.startsWith("support"))).toEqual([]);
  });

  it("logs and swallows a failure", async () => {
    const { auth, rt } = await setup();
    await seedEmailTicket(auth);
    const context = await getContext(auth);
    const error = vi
      .spyOn(context.logger, "error")
      .mockImplementation(() => {});
    const broken = {
      ...context,
      adapter: {
        ...context.adapter,
        findMany: async () => {
          throw new Error("db down");
        },
      },
    } as typeof context;
    const hooks = userLinkHooks(broken, rt.opts);
    await expect(
      hooks.update.after({
        id: "user_x",
        email: EMAIL,
        emailVerified: true,
        name: "Pat",
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it("doesn't rely on updateMany's returned count", async () => {
    const { auth, rt } = await setup();
    const { ticket } = await seedEmailTicket(auth);
    const context = await getContext(auth);
    // some drivers answer 0 even when rows changed
    const zeroCount = {
      ...context,
      adapter: {
        ...context.adapter,
        updateMany: async (
          args: Parameters<typeof context.adapter.updateMany>[0],
        ) => {
          await context.adapter.updateMany(args);
          return 0;
        },
      },
    } as typeof context;
    const error = vi.spyOn(context.logger, "error");
    await userLinkHooks(zeroCount, rt.opts).update.after({
      id: "user_pat",
      email: EMAIL,
      emailVerified: true,
      name: "Pat",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(error).not.toHaveBeenCalled();
    expect((await ticketRow(rt, ticket.id)).userId).toBe("user_pat");
    error.mockRestore();
  });

  it("stops with an error when an update changes nothing", async () => {
    const { auth, rt } = await setup();
    await seedEmailTicket(auth);
    const context = await getContext(auth);
    const updates: unknown[] = [];
    const stuck = {
      ...context,
      adapter: {
        ...context.adapter,
        updateMany: async (args: unknown) => {
          updates.push(args);
          return 1;
        },
      },
    } as typeof context;
    const error = vi
      .spyOn(context.logger, "error")
      .mockImplementation(() => {});
    await userLinkHooks(stuck, rt.opts).update.after({
      id: "user_pat",
      email: EMAIL,
      emailVerified: true,
      name: "Pat",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(updates).toHaveLength(1);
    expect(error).toHaveBeenCalledOnce();
    expect(String(error.mock.calls[0]?.[1])).toContain(
      "supportTicket rows to link were not updated",
    );
    error.mockRestore();
  });

  describe("linkSupportRequester", () => {
    it("links a verified user's tickets and messages and reports counts", async () => {
      const { auth, rt } = await setup();
      const pat = await signUpUser(auth, EMAIL, { verified: true });
      // rows that arrived after sign-up (an import, say)
      const first = await seedEmailTicket(auth);
      const second = await seedEmailTicket(auth);
      await seedEmailTicket(auth, { verified: false });

      const result = await linkSupportRequester(auth, pat.user.id);
      expect(result).toEqual({ tickets: 2, messages: 2 });
      expect((await ticketRow(rt, first.ticket.id)).userId).toBe(pat.user.id);
      expect((await ticketRow(rt, second.ticket.id)).userId).toBe(pat.user.id);
      expect((await messageRow(rt, first.message.id)).authorEmail ?? null).toBe(
        null,
      );
      // nothing left to link
      expect(await linkSupportRequester(auth, pat.user.id)).toEqual({
        tickets: 0,
        messages: 0,
      });
    });

    it("returns zeros for an unverified or missing user", async () => {
      const { auth, rt } = await setup();
      const pat = await signUpUser(auth, EMAIL);
      const { ticket } = await seedEmailTicket(auth);
      expect(await linkSupportRequester(auth, pat.user.id)).toEqual({
        tickets: 0,
        messages: 0,
      });
      expect(await linkSupportRequester(auth, "no_such_user")).toEqual({
        tickets: 0,
        messages: 0,
      });
      expect((await ticketRow(rt, ticket.id)).userId ?? null).toBeNull();
    });

    it("throws without the support plugin", async () => {
      const auth = { $context: Promise.resolve({ options: { plugins: [] } }) };
      await expect(linkSupportRequester(auth, "u")).rejects.toThrow(
        "[@byo-oss/support] linkSupportRequester needs the support plugin installed on this auth instance",
      );
    });
  });
});
