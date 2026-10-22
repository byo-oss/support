// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type SupportFetchClient,
  useSupportAgentTicket,
  useSupportCannedReplies,
  useSupportQueue,
  useSupportTicket,
  useSupportTickets,
  useSupportUpload,
} from ".";

const ok = <T,>(data: T) => Promise.resolve({ data, error: null });
const fail = (error: unknown) => Promise.resolve({ data: null, error });

function ticket(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    number: 1,
    subject: `Ticket ${id}`,
    status: "open",
    ...extra,
  };
}

function message(id: string) {
  return { id, kind: "reply", body: `Message ${id}` };
}

/**
 * A fake client. Every endpoint is a `vi.fn` with a default success answer;
 * tests override one with `mockResolvedValueOnce` or `mockImplementation`.
 */
function makeClient(options: { merge?: boolean } = {}) {
  const mocks = {
    createTicket: vi.fn(() => ok({ ticket: ticket("new") })),
    myTickets: vi.fn(() =>
      ok({
        tickets: [ticket("t1"), ticket("t2")],
        nextCursor: null,
        features: { attachments: true },
      }),
    ),
    ticket: vi.fn(() =>
      ok({
        ticket: ticket("t1"),
        messages: [message("m1")],
        attachments: [{ id: "a1" }],
      }),
    ),
    reply: vi.fn(() => ok({ message: message("m2") })),
    updateMine: vi.fn(() => ok({ ticket: ticket("t1", { status: "solved" }) })),
    markSeen: vi.fn(() => ok({ ok: true })),
    agentTickets: vi.fn(() =>
      ok({
        tickets: [ticket("t1"), ticket("t2")],
        nextCursor: null,
        counts: { open: 2, pending: 1, unassigned: 1, mine: 0 },
        features: { attachments: true, merge: true },
      }),
    ),
    agentTicket: vi.fn(() =>
      ok({
        ticket: ticket("t1"),
        messages: [message("m1")],
        attachments: [{ id: "a1" }],
      }),
    ),
    agentReply: vi.fn(() => ok({ message: message("m2") })),
    agentUpdate: vi.fn(() => ok({ updated: 2 })),
    agentMerge: vi.fn(() => ok({ ticket: ticket("target") })),
    agentDelete: vi.fn(() => ok({ deleted: 1 })),
    agentMarkSeen: vi.fn(() => ok({ ok: true })),
    tags: vi.fn(() => ok(["billing", "bug"])),
    canned: vi.fn(() => ok([{ id: "c1", title: "Hi", body: "Hello" }])),
    cannedSave: vi.fn(() =>
      ok({ cannedReply: { id: "c2", title: "New", body: "Body" } }),
    ),
    cannedDelete: vi.fn(() => ok({ ok: true })),
    $fetch: vi.fn(
      (
        _path: string,
        _options: unknown,
      ): Promise<{ data: unknown; error: unknown }> =>
        ok({ attachment: { id: "up1", filename: "a.png" } }),
    ),
  };
  const canned = Object.assign(mocks.canned, {
    save: mocks.cannedSave,
    delete: mocks.cannedDelete,
  });
  const client = {
    support: {
      createTicket: mocks.createTicket,
      myTickets: mocks.myTickets,
      ticket: mocks.ticket,
      reply: mocks.reply,
      updateMine: mocks.updateMine,
      markSeen: mocks.markSeen,
      agent: {
        tickets: mocks.agentTickets,
        ticket: mocks.agentTicket,
        reply: mocks.agentReply,
        update: mocks.agentUpdate,
        ...(options.merge === false ? {} : { merge: mocks.agentMerge }),
        delete: mocks.agentDelete,
        markSeen: mocks.agentMarkSeen,
        tags: mocks.tags,
        canned,
      },
    },
    $fetch: mocks.$fetch,
  } as unknown as SupportFetchClient;
  return { client, mocks };
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

afterEach(() => {
  // Unmount first: without globals Testing Library doesn't clean up on its
  // own, so every hook stays mounted and polling. The visibility event below
  // would then start a refresh in each, whose state update React schedules
  // after the file's environment is torn down ("window is not defined").
  cleanup();
  vi.useRealTimers();
  setVisibility("visible");
});

describe("useSupportTickets", () => {
  it("loads tickets and the server's features", async () => {
    const { client, mocks } = makeClient();
    const { result } = renderHook(() => useSupportTickets(client));

    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.tickets.map((t) => t.id)).toEqual(["t1", "t2"]);
    // an older server sends no categories: none offered
    expect(result.current.features).toEqual({
      attachments: true,
      categories: [],
    });
    expect(result.current.hasMore).toBe(false);
    expect(result.current.error).toBeNull();
    expect(mocks.myTickets).toHaveBeenCalledWith({ query: {} });
  });

  it("passes the filters and reloads when they change", async () => {
    const { client, mocks } = makeClient();
    const { result, rerender } = renderHook(
      (props: { status?: "open" | "solved" }) =>
        useSupportTickets(client, { organizationId: "o1", q: "x", ...props }),
      { initialProps: { status: "open" } },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mocks.myTickets).toHaveBeenLastCalledWith({
      query: { status: "open", organizationId: "o1", q: "x" },
    });

    rerender({ status: "solved" });
    expect(result.current.isLoading).toBe(true);
    expect(result.current.tickets).toEqual([]);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mocks.myTickets).toHaveBeenLastCalledWith({
      query: { status: "solved", organizationId: "o1", q: "x" },
    });
  });

  it("appends the next page with loadMore and keeps it across polls", async () => {
    const { client, mocks } = makeClient();
    mocks.myTickets.mockImplementation(((input?: {
      query?: { cursor?: string };
    }) =>
      input?.query?.cursor === "c1"
        ? ok({
            tickets: [ticket("t3")],
            nextCursor: null,
            features: { attachments: true },
          })
        : ok({
            tickets: [ticket("t1"), ticket("t2")],
            nextCursor: "c1",
            features: { attachments: true },
          })) as never);
    const { result } = renderHook(() => useSupportTickets(client));
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    await act(() => result.current.loadMore());
    expect(mocks.myTickets).toHaveBeenLastCalledWith({
      query: { cursor: "c1" },
    });
    expect(result.current.tickets.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
    expect(result.current.hasMore).toBe(false);

    // a refresh replaces page one and keeps the loaded page
    await act(() => result.current.refresh());
    expect(result.current.tickets.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
    expect(result.current.hasMore).toBe(false);
  });

  it("creates a ticket, then refetches", async () => {
    const { client, mocks } = makeClient();
    const { result } = renderHook(() => useSupportTickets(client));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mocks.myTickets).toHaveBeenCalledTimes(1);

    let created: unknown;
    await act(async () => {
      created = await result.current.createTicket({
        subject: "Help",
        body: "Please",
      });
    });
    expect(created).toMatchObject({ id: "new" });
    expect(mocks.createTicket).toHaveBeenCalledWith({
      subject: "Help",
      body: "Please",
    });
    expect(mocks.myTickets).toHaveBeenCalledTimes(2);
  });

  it("surfaces errors without throwing and recovers on the next load", async () => {
    const { client, mocks } = makeClient();
    mocks.myTickets.mockImplementationOnce((() =>
      fail({ code: "NOPE", message: "no" })) as never);
    const { result } = renderHook(() => useSupportTickets(client));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toEqual({ code: "NOPE", message: "no" });
    expect(result.current.tickets).toEqual([]);

    await act(() => result.current.refresh());
    expect(result.current.error).toBeNull();
    expect(result.current.tickets).toHaveLength(2);
  });

  it("reports a failed createTicket as null with error set", async () => {
    const { client, mocks } = makeClient();
    mocks.createTicket.mockImplementationOnce((() =>
      fail({ code: "NOT_A_MEMBER" })) as never);
    const { result } = renderHook(() => useSupportTickets(client));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let created: unknown = "unset";
    await act(async () => {
      created = await result.current.createTicket({ subject: "a", body: "b" });
    });
    expect(created).toBeNull();
    expect(result.current.error).toEqual({ code: "NOT_A_MEMBER" });
    expect(mocks.myTickets).toHaveBeenCalledTimes(1);
  });

  it("survives a transport rejection", async () => {
    const { client, mocks } = makeClient();
    mocks.myTickets.mockImplementationOnce((() =>
      Promise.reject(new Error("offline"))) as never);
    const { result } = renderHook(() => useSupportTickets(client));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toEqual(new Error("offline"));
  });
});

describe("polling", () => {
  it("polls on the interval, pauses while hidden and resumes", async () => {
    vi.useFakeTimers();
    const { client, mocks } = makeClient();
    renderHook(() => useSupportTickets(client, { pollInterval: 1000 }));

    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.myTickets).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.myTickets).toHaveBeenCalledTimes(2);

    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.myTickets).toHaveBeenCalledTimes(2);

    // becoming visible catches up at once, then the interval continues
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.myTickets).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.myTickets).toHaveBeenCalledTimes(4);
  });

  it("defaults to 15 seconds", async () => {
    vi.useFakeTimers();
    const { client, mocks } = makeClient();
    renderHook(() => useSupportQueue(client));
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.agentTickets).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(14_000);
    expect(mocks.agentTickets).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.agentTickets).toHaveBeenCalledTimes(2);
  });

  it("does not poll with pollInterval 0 and stops on unmount", async () => {
    vi.useFakeTimers();
    const { client, mocks } = makeClient();
    renderHook(() => useSupportTicket(client, "t1", { pollInterval: 0 }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.ticket).toHaveBeenCalledTimes(1);

    const second = renderHook(() =>
      useSupportAgentTicket(client, "t1", { pollInterval: 1000 }),
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.agentTicket).toHaveBeenCalledTimes(2);
    second.unmount();
    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.agentTicket).toHaveBeenCalledTimes(2);
  });
});

describe("useSupportTicket", () => {
  it("loads the thread; a null id stays idle", async () => {
    const { client, mocks } = makeClient();
    const idle = renderHook(() => useSupportTicket(client, null));
    expect(idle.result.current.isLoading).toBe(false);
    expect(idle.result.current.ticket).toBeNull();
    expect(mocks.ticket).not.toHaveBeenCalled();

    const { result } = renderHook(() => useSupportTicket(client, "t1"));
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.ticket?.id).toBe("t1");
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.attachments).toHaveLength(1);
    expect(mocks.ticket).toHaveBeenCalledWith({ query: { id: "t1" } });
  });

  it("refetches after reply, update and markSeen", async () => {
    const { client, mocks } = makeClient();
    const { result } = renderHook(() => useSupportTicket(client, "t1"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mocks.ticket).toHaveBeenCalledTimes(1);

    let done: boolean | undefined;
    await act(async () => {
      done = await result.current.reply({ body: "Hi", attachmentIds: ["a"] });
    });
    expect(done).toBe(true);
    expect(mocks.reply).toHaveBeenCalledWith({
      ticketId: "t1",
      body: "Hi",
      attachmentIds: ["a"],
    });
    expect(mocks.ticket).toHaveBeenCalledTimes(2);

    await act(async () => {
      done = await result.current.update({ status: "solved", rating: "good" });
    });
    expect(done).toBe(true);
    expect(mocks.updateMine).toHaveBeenCalledWith({
      id: "t1",
      status: "solved",
      rating: "good",
    });
    expect(mocks.ticket).toHaveBeenCalledTimes(3);

    await act(() => result.current.markSeen());
    expect(mocks.markSeen).toHaveBeenCalledWith({ id: "t1" });
    expect(mocks.ticket).toHaveBeenCalledTimes(4);
  });

  it("returns false and sets error when a mutation fails, without refetching", async () => {
    const { client, mocks } = makeClient();
    mocks.reply.mockImplementationOnce((() =>
      fail({ code: "TICKET_CLOSED" })) as never);
    const { result } = renderHook(() => useSupportTicket(client, "t1"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let done: boolean | undefined;
    await act(async () => {
      done = await result.current.reply({ body: "Hi" });
    });
    expect(done).toBe(false);
    expect(result.current.error).toEqual({ code: "TICKET_CLOSED" });
    expect(mocks.ticket).toHaveBeenCalledTimes(1);
  });

  it("acts on the returned ticket id after a merge", async () => {
    const { client, mocks } = makeClient();
    mocks.ticket.mockImplementation((() =>
      ok({
        ticket: ticket("target"),
        messages: [],
        attachments: [],
      })) as never);
    const { result } = renderHook(() => useSupportTicket(client, "source"));
    await waitFor(() => expect(result.current.ticket?.id).toBe("target"));

    await act(async () => {
      await result.current.reply({ body: "Hi" });
      await result.current.update({ rating: "bad" });
      await result.current.markSeen();
    });
    expect(mocks.ticket).toHaveBeenCalledWith({ query: { id: "source" } });
    expect(mocks.reply).toHaveBeenCalledWith({
      ticketId: "target",
      body: "Hi",
    });
    expect(mocks.updateMine).toHaveBeenCalledWith({
      id: "target",
      rating: "bad",
    });
    expect(mocks.markSeen).toHaveBeenCalledWith({ id: "target" });
  });

  it("openAttachment GETs /support/attachment and returns a Blob", async () => {
    const { client, mocks } = makeClient();
    const blob = new Blob(["png"], { type: "image/png" });
    mocks.$fetch.mockImplementationOnce(() => ok(blob));
    const { result } = renderHook(() => useSupportTicket(client, "t1"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let got: Blob | null = null;
    await act(async () => {
      got = await result.current.openAttachment("a1");
    });
    expect(got).toBe(blob);
    expect(mocks.$fetch).toHaveBeenCalledWith("/support/attachment", {
      method: "GET",
      query: { id: "a1" },
    });
  });

  it("openAttachment wraps a non-Blob body and returns null with error on failure", async () => {
    const { client, mocks } = makeClient();
    const { result } = renderHook(() => useSupportTicket(client, "t1"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    mocks.$fetch.mockImplementationOnce(() => ok("raw text"));
    let got: Blob | null = null;
    await act(async () => {
      got = await result.current.openAttachment("a1");
    });
    expect(got).toBeInstanceOf(Blob);
    expect(await (got as unknown as Blob).text()).toBe("raw text");

    mocks.$fetch.mockImplementationOnce(() =>
      fail({ code: "ATTACHMENT_NOT_FOUND" }),
    );
    await act(async () => {
      got = await result.current.openAttachment("gone");
    });
    expect(got).toBeNull();
    expect(result.current.error).toEqual({ code: "ATTACHMENT_NOT_FOUND" });
  });
});

describe("useSupportQueue", () => {
  it("loads tickets, counts, features and tags", async () => {
    const { client, mocks } = makeClient();
    const { result } = renderHook(() =>
      useSupportQueue(client, { status: "open", assignee: "me", tag: "bug" }),
    );
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.tickets).toHaveLength(2);
    expect(result.current.counts).toEqual({
      open: 2,
      pending: 1,
      unassigned: 1,
      mine: 0,
    });
    expect(result.current.features).toEqual({
      attachments: true,
      merge: true,
      categories: [],
    });
    expect(result.current.tags).toEqual(["billing", "bug"]);
    expect(mocks.agentTickets).toHaveBeenCalledWith({
      query: { status: "open", assignee: "me", tag: "bug" },
    });
  });

  it("appends pages with loadMore", async () => {
    const { client, mocks } = makeClient();
    mocks.agentTickets.mockImplementation(((input?: {
      query?: { cursor?: string };
    }) =>
      ok({
        tickets: input?.query?.cursor ? [ticket("t3")] : [ticket("t1")],
        nextCursor: input?.query?.cursor ? null : "c1",
        counts: { open: 3, pending: 0, unassigned: 0, mine: 0 },
        features: { attachments: false, merge: true },
      })) as never);
    const { result } = renderHook(() => useSupportQueue(client));
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    await act(() => result.current.loadMore());
    expect(mocks.agentTickets).toHaveBeenLastCalledWith({
      query: { cursor: "c1" },
    });
    expect(result.current.tickets.map((t) => t.id)).toEqual(["t1", "t3"]);
    expect(result.current.hasMore).toBe(false);
    // counts and tags come from the first page
    expect(result.current.counts.open).toBe(3);
    expect(result.current.tags).toEqual(["billing", "bug"]);
  });

  it("refetches after update, merge and remove and returns their results", async () => {
    const { client, mocks } = makeClient();
    const { result } = renderHook(() => useSupportQueue(client));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mocks.agentTickets).toHaveBeenCalledTimes(1);

    let updated: number | null = null;
    await act(async () => {
      updated = await result.current.update(["t1", "t2"], {
        status: "pending",
        assigneeId: null,
        addTags: ["bug"],
      });
    });
    expect(updated).toBe(2);
    expect(mocks.agentUpdate).toHaveBeenCalledWith({
      ids: ["t1", "t2"],
      status: "pending",
      assigneeId: null,
      addTags: ["bug"],
    });
    expect(mocks.agentTickets).toHaveBeenCalledTimes(2);

    let merged: unknown;
    await act(async () => {
      merged = await result.current.merge?.("s", "target");
    });
    expect(merged).toMatchObject({ id: "target" });
    expect(mocks.agentMerge).toHaveBeenCalledWith({
      sourceId: "s",
      targetId: "target",
    });
    expect(mocks.agentTickets).toHaveBeenCalledTimes(3);

    let removed: number | null = null;
    await act(async () => {
      removed = await result.current.remove(["t1"]);
    });
    expect(removed).toBe(1);
    expect(mocks.agentDelete).toHaveBeenCalledWith({ ids: ["t1"] });
    expect(mocks.agentTickets).toHaveBeenCalledTimes(4);
  });

  it("returns null and sets error when a bulk action fails", async () => {
    const { client, mocks } = makeClient();
    mocks.agentUpdate.mockImplementationOnce((() =>
      fail({ code: "NOT_AN_AGENT" })) as never);
    const { result } = renderHook(() => useSupportQueue(client));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let updated: number | null = 0;
    await act(async () => {
      updated = await result.current.update(["t1"], { assigneeId: "u9" });
    });
    expect(updated).toBeNull();
    expect(result.current.error).toEqual({ code: "NOT_AN_AGENT" });
    expect(mocks.agentTickets).toHaveBeenCalledTimes(1);
  });

  it("has no merge when the client has none", async () => {
    const { client } = makeClient({ merge: false });
    const { result } = renderHook(() => useSupportQueue(client));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.merge).toBeUndefined();
  });

  it("surfaces a failed tags request as an error", async () => {
    const { client, mocks } = makeClient();
    mocks.tags.mockImplementationOnce((() =>
      fail({ code: "NOT_ALLOWED" })) as never);
    const { result } = renderHook(() => useSupportQueue(client));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toEqual({ code: "NOT_ALLOWED" });
  });
});

describe("useSupportAgentTicket", () => {
  it("loads the thread and refetches after each mutation", async () => {
    const { client, mocks } = makeClient();
    const { result } = renderHook(() => useSupportAgentTicket(client, "t1"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.ticket?.id).toBe("t1");
    expect(result.current.messages).toHaveLength(1);
    expect(mocks.agentTicket).toHaveBeenCalledWith({ query: { id: "t1" } });

    await act(async () => {
      await result.current.reply({
        body: "Note",
        internal: true,
        mentions: ["u2"],
        attachmentIds: ["a"],
      });
    });
    expect(mocks.agentReply).toHaveBeenCalledWith({
      ticketId: "t1",
      body: "Note",
      internal: true,
      mentions: ["u2"],
      attachmentIds: ["a"],
    });
    expect(mocks.agentTicket).toHaveBeenCalledTimes(2);

    await act(async () => {
      await result.current.update({ priority: "high", assigneeId: "u1" });
    });
    expect(mocks.agentUpdate).toHaveBeenCalledWith({
      ids: ["t1"],
      priority: "high",
      assigneeId: "u1",
    });
    expect(mocks.agentTicket).toHaveBeenCalledTimes(3);

    await act(() => result.current.markSeen());
    expect(mocks.agentMarkSeen).toHaveBeenCalledWith({ id: "t1" });
    expect(mocks.agentTicket).toHaveBeenCalledTimes(4);
  });

  it("acts on the returned ticket id after a merge", async () => {
    const { client, mocks } = makeClient();
    mocks.agentTicket.mockImplementation((() =>
      ok({
        ticket: ticket("target"),
        messages: [],
        attachments: [],
      })) as never);
    const { result } = renderHook(() =>
      useSupportAgentTicket(client, "source"),
    );
    await waitFor(() => expect(result.current.ticket?.id).toBe("target"));
    await act(async () => {
      await result.current.reply({ body: "Hi" });
      await result.current.update({ status: "solved" });
    });
    expect(mocks.agentReply).toHaveBeenCalledWith({
      ticketId: "target",
      body: "Hi",
    });
    expect(mocks.agentUpdate).toHaveBeenCalledWith({
      ids: ["target"],
      status: "solved",
    });
  });

  it("stays idle for a null id", async () => {
    const { client, mocks } = makeClient();
    const { result } = renderHook(() => useSupportAgentTicket(client, null));
    expect(result.current.isLoading).toBe(false);
    let done: boolean | undefined;
    await act(async () => {
      done = await result.current.reply({ body: "x" });
    });
    expect(done).toBe(false);
    expect(mocks.agentTicket).not.toHaveBeenCalled();
    expect(mocks.agentReply).not.toHaveBeenCalled();
  });

  it("openAttachment GETs /support/agent/attachment", async () => {
    const { client, mocks } = makeClient();
    const blob = new Blob(["pdf"], { type: "application/pdf" });
    mocks.$fetch.mockImplementationOnce(() => ok(blob));
    const { result } = renderHook(() => useSupportAgentTicket(client, "t1"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let got: Blob | null = null;
    await act(async () => {
      got = await result.current.openAttachment("a1");
    });
    expect(got).toBe(blob);
    expect(mocks.$fetch).toHaveBeenCalledWith("/support/agent/attachment", {
      method: "GET",
      query: { id: "a1" },
    });

    mocks.$fetch.mockImplementationOnce(() => fail({ code: "X" }));
    await act(async () => {
      got = await result.current.openAttachment("a2");
    });
    expect(got).toBeNull();
    expect(result.current.error).toEqual({ code: "X" });
  });
});

describe("useSupportCannedReplies", () => {
  it("loads, filters by q, saves and removes with a refetch", async () => {
    const { client, mocks } = makeClient();
    const { result } = renderHook(() =>
      useSupportCannedReplies(client, { q: "hi" }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.cannedReplies).toHaveLength(1);
    expect(mocks.canned).toHaveBeenCalledWith({ query: { q: "hi" } });

    let saved: unknown;
    await act(async () => {
      saved = await result.current.save({ title: "New", body: "Body" });
    });
    expect(saved).toMatchObject({ id: "c2" });
    expect(mocks.cannedSave).toHaveBeenCalledWith({
      title: "New",
      body: "Body",
    });
    expect(mocks.canned).toHaveBeenCalledTimes(2);

    let removed: boolean | undefined;
    await act(async () => {
      removed = await result.current.remove("c1");
    });
    expect(removed).toBe(true);
    expect(mocks.cannedDelete).toHaveBeenCalledWith({ id: "c1" });
    expect(mocks.canned).toHaveBeenCalledTimes(3);
  });

  it("reports failures without throwing", async () => {
    const { client, mocks } = makeClient();
    mocks.cannedSave.mockImplementationOnce((() =>
      fail({ code: "NOT_ALLOWED" })) as never);
    const { result } = renderHook(() => useSupportCannedReplies(client));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let saved: unknown = "unset";
    await act(async () => {
      saved = await result.current.save({ title: "a", body: "b" });
    });
    expect(saved).toBeNull();
    expect(result.current.error).toEqual({ code: "NOT_ALLOWED" });
  });
});

describe("useSupportUpload", () => {
  it("sends a raw body to /support/upload and tracks the upload", async () => {
    const { client, mocks } = makeClient();
    let release: (value: { data: unknown; error: unknown }) => void = () => {};
    mocks.$fetch.mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve)),
    );
    const { result } = renderHook(() =>
      useSupportUpload(client, { ticketId: "t1" }),
    );
    expect(result.current.isUploading).toBe(false);

    const file = new Blob(["abc"], { type: "image/png" });
    let pending: Promise<unknown> = Promise.resolve();
    act(() => {
      pending = result.current.upload(file, "pic.png");
    });
    expect(result.current.isUploading).toBe(true);
    const [path, options] = mocks.$fetch.mock.calls[0] as [
      string,
      { method: string; query: unknown; body: unknown; headers: unknown },
    ];
    expect(path).toBe("/support/upload");
    expect(options).toEqual({
      method: "POST",
      query: { ticketId: "t1", filename: "pic.png" },
      body: file,
      headers: { "content-type": "image/png" },
    });

    await act(async () => {
      release({ data: { attachment: { id: "up1" } }, error: null });
      await pending;
    });
    expect(result.current.isUploading).toBe(false);
    expect(result.current.uploads).toEqual([{ id: "up1" }]);
    expect(result.current.error).toBeNull();
  });

  it("uploads through the agent endpoint with internal, and reset clears", async () => {
    const { client, mocks } = makeClient();
    const { result, rerender } = renderHook(
      (props: { internal: boolean }) =>
        useSupportUpload(client, { ticketId: "t1", agent: true, ...props }),
      { initialProps: { internal: false } },
    );
    await act(async () => {
      await result.current.upload(new Blob(["a"]), "a.txt");
    });
    expect(mocks.$fetch).toHaveBeenLastCalledWith("/support/agent/upload", {
      method: "POST",
      query: { ticketId: "t1", filename: "a.txt", internal: "false" },
      body: expect.any(Blob),
      headers: { "content-type": "application/octet-stream" },
    });

    rerender({ internal: true });
    await act(async () => {
      await result.current.upload(new Blob(["b"]), "b.txt");
    });
    expect(mocks.$fetch).toHaveBeenLastCalledWith(
      "/support/agent/upload",
      expect.objectContaining({
        query: { ticketId: "t1", filename: "b.txt", internal: "true" },
      }),
    );
    expect(result.current.uploads).toHaveLength(2);

    act(() => result.current.remove("up1"));
    expect(result.current.uploads).toHaveLength(0);

    await act(async () => {
      await result.current.upload(new Blob(["c"]), "c.txt");
    });
    expect(result.current.uploads).toHaveLength(1);
    act(() => result.current.reset());
    expect(result.current.uploads).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it("uses the File name by default", async () => {
    const { client, mocks } = makeClient();
    const { result } = renderHook(() =>
      useSupportUpload(client, { ticketId: "t1" }),
    );
    await act(async () => {
      await result.current.upload(
        new File(["x"], "report.pdf", { type: "application/pdf" }),
      );
    });
    expect(mocks.$fetch).toHaveBeenCalledWith(
      "/support/upload",
      expect.objectContaining({
        query: { ticketId: "t1", filename: "report.pdf" },
        headers: { "content-type": "application/pdf" },
      }),
    );
  });

  it("returns null and sets error on failure, and drops an upload that finishes after reset", async () => {
    const { client, mocks } = makeClient();
    mocks.$fetch.mockImplementationOnce(() =>
      fail({ code: "ATTACHMENT_TOO_LARGE" }),
    );
    const { result } = renderHook(() =>
      useSupportUpload(client, { ticketId: "t1" }),
    );
    let got: unknown = "unset";
    await act(async () => {
      got = await result.current.upload(new Blob(["a"]), "a");
    });
    expect(got).toBeNull();
    expect(result.current.error).toEqual({ code: "ATTACHMENT_TOO_LARGE" });
    expect(result.current.uploads).toEqual([]);

    let release: (value: { data: unknown; error: unknown }) => void = () => {};
    mocks.$fetch.mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve)),
    );
    let pending: Promise<unknown> = Promise.resolve();
    act(() => {
      pending = result.current.upload(new Blob(["b"]), "b");
    });
    act(() => result.current.reset());
    await act(async () => {
      release({ data: { attachment: { id: "late" } }, error: null });
      await pending;
    });
    expect(result.current.uploads).toEqual([]);
  });
});
