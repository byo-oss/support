// @vitest-environment happy-dom
import {
  act,
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupportFetchClient } from "../hooks";
import { defaultLabels, type SupportLabels } from "../labels";
import { SupportInbox, type SupportInboxProps } from "./index";
import { defaultInboxLabels, type SupportInboxLabels } from "./labels";

// ---------------------------------------------------------------------------
// Fixtures: complete rows, because the components read most fields. Texts
// avoid the words of the default labels, so the "no English left" scan holds.
// ---------------------------------------------------------------------------

const NOW = new Date().toISOString();
const ok = <T,>(data: T): Promise<{ data: T | null; error: unknown }> =>
  Promise.resolve({ data, error: null });
const fail = (error: unknown) => Promise.resolve({ data: null, error });

const ALICE = { id: "u-alice", name: "Alice" };
const BOB = { id: "u-bob", name: "Bob" };
const AGENTS = [ALICE, BOB];

const SUBJECTS = ["Login broken", "Printer jam", "Refund needed"];

type Row = Record<string, unknown>;

function ticket(n: number, extra: Row = {}): Row {
  return {
    id: `t${n}`,
    number: n,
    subject: SUBJECTS[n - 1] ?? `Topic ${n}`,
    status: "open",
    priority: null,
    channel: "web",
    userId: `c${n}`,
    requester: {
      id: `c${n}`,
      name: `Cora ${n}`,
      email: `cora${n}@example.com`,
      image: null,
    },
    organizationId: null,
    visibility: "private",
    assigneeId: null,
    assignee: null,
    rating: null,
    verified: true,
    mergedIntoId: null,
    requesterSeenAt: NOW,
    agentSeenAt: NOW,
    lastMessageAt: NOW,
    solvedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    tags: [],
    unread: false,
    ...extra,
  };
}

function message(id: string, extra: Row = {}): Row {
  return {
    id,
    ticketId: "t1",
    kind: "reply",
    authorType: "customer",
    userId: "c1",
    author: {
      id: "c1",
      name: "Cora 1",
      email: "cora1@example.com",
      image: null,
    },
    body: `Words of ${id}`,
    data: null,
    mentions: [],
    channel: "web",
    verified: true,
    emailMessageId: null,
    createdAt: NOW,
    ...extra,
  };
}

function attachment(id: string, messageId: string, extra: Row = {}): Row {
  return {
    id,
    ticketId: "t1",
    messageId,
    filename: `${id}.pdf`,
    contentType: "application/pdf",
    size: 2048,
    internal: false,
    createdAt: NOW,
    ...extra,
  };
}

type Options = {
  tickets?: Row[];
  nextCursor?: string | null;
  features?: { attachments: boolean; merge: boolean };
  /** false: the client has no `merge` method */
  merge?: boolean;
  /** false: the client has no canned save/delete */
  cannedManage?: boolean;
  messages?: Row[];
  attachments?: Row[];
  canned?: Row[];
  ticketsFor?: (query: Row | undefined) => Row[];
};

function makeClient(options: Options = {}) {
  const tickets = options.tickets ?? [
    ticket(1, { unread: false }),
    ticket(2),
    ticket(3),
  ];
  const features = options.features ?? { attachments: true, merge: true };
  const messages = options.messages ?? [message("m1")];
  const mocks = {
    tickets: vi.fn((input?: { query?: Row }) =>
      ok({
        tickets: options.ticketsFor?.(input?.query) ?? tickets,
        nextCursor: options.nextCursor ?? null,
        counts: { open: 3, pending: 1, unassigned: 2, mine: 1 },
        features,
      }),
    ),
    ticket: vi.fn((input: { query: { id: string } }) =>
      ok({
        ticket: tickets.find((t) => t.id === input.query.id) ?? tickets[0],
        messages,
        attachments: options.attachments ?? [],
      }),
    ),
    reply: vi.fn((_input: Row) => ok({ message: message("new") })),
    update: vi.fn((_input: Row) => ok({ updated: 1 })),
    merge: vi.fn((_input: Row) => ok({ ticket: ticket(2) })),
    delete: vi.fn((_input: Row) => ok({ deleted: 1 })),
    markSeen: vi.fn((_input: Row) => ok({ ok: true })),
    tags: vi.fn(() => ok(["billing", "bug"])),
    canned: vi.fn((_input?: Row) =>
      ok(
        options.canned ?? [
          { id: "c1", title: "Greeting", body: "Hello, thanks for writing" },
        ],
      ),
    ),
    cannedSave: vi.fn((_input: Row) =>
      ok({ cannedReply: { id: "c2", title: "New", body: "Body" } }),
    ),
    cannedDelete: vi.fn((_input: Row) => ok({ ok: true })),
    $fetch: vi.fn(
      (
        _path: string,
        _options: Row,
      ): Promise<{ data: unknown; error: unknown }> =>
        ok({ attachment: { id: "up1", filename: "up1.png", size: 100 } }),
    ),
  };
  const canned = Object.assign(
    mocks.canned,
    options.cannedManage === false
      ? {}
      : { save: mocks.cannedSave, delete: mocks.cannedDelete },
  );
  const client = {
    support: {
      agent: {
        tickets: mocks.tickets,
        ticket: mocks.ticket,
        reply: mocks.reply,
        update: mocks.update,
        ...(options.merge === false ? {} : { merge: mocks.merge }),
        delete: mocks.delete,
        markSeen: mocks.markSeen,
        tags: mocks.tags,
        canned,
      },
    },
    $fetch: mocks.$fetch,
  } as unknown as SupportFetchClient;
  return { client, mocks };
}

function renderInbox(
  options: Options = {},
  props: Partial<SupportInboxProps> = {},
) {
  const made = makeClient(options);
  const view = render(
    <SupportInbox
      client={made.client}
      agents={AGENTS}
      pollInterval={0}
      {...props}
    />,
  );
  return { ...made, ...view };
}

/** Renders, waits for the queue, opens ticket `subject`. */
async function openTicket(
  options: Options = {},
  props: Partial<SupportInboxProps> = {},
  subject = "Login broken",
) {
  const rendered = renderInbox(options, props);
  await screen.findByText(subject);
  fireEvent.click(screen.getByRole("button", { name: new RegExp(subject) }));
  await screen.findByRole("log");
  // let the passive effects of the freshly mounted thread run: the upload
  // hook resets itself on mount, which would drop an upload started first
  await act(async () => {});
  return rendered;
}

const textbox = () =>
  screen.getByRole("textbox", {
    name: "Write a message",
  }) as HTMLTextAreaElement;
const sendButton = () => screen.getByRole("button", { name: "Send" });

function write(text: string) {
  fireEvent.change(textbox(), { target: { value: text } });
}

// debounced searches and polling-free hooks settle fast, but CI can be slow
configure({ asyncUtilTimeout: 3000 });

const restores: (() => void)[] = [];

/** Sets `target[key]` for one test (happy-dom lacks some of these) and undoes it after. */
function stub(target: object, key: string, value: unknown) {
  const had = Object.hasOwn(target, key);
  const original = (target as Record<string, unknown>)[key];
  Object.defineProperty(target, key, {
    configurable: true,
    writable: true,
    value,
  });
  restores.push(() => {
    if (had) {
      Object.defineProperty(target, key, {
        configurable: true,
        writable: true,
        value: original,
      });
    } else {
      delete (target as Record<string, unknown>)[key];
    }
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  for (const restore of restores.splice(0)) restore();
});

// ---------------------------------------------------------------------------

describe("queue", () => {
  it("lists tickets, counts and announces unread and queue counts", async () => {
    renderInbox({
      tickets: [ticket(1, { unread: true, tags: ["billing"] }), ticket(2)],
    });
    await screen.findByText("Login broken");
    expect(screen.getByText("Printer jam")).toBeTruthy();
    expect(screen.getByRole("button", { name: /billing/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "3 open" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "1 pending" })).toBeTruthy();
    const region = screen.getByRole("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.textContent).toBe(
      "1 unread ticket. 3 open, 1 pending, 2 unassigned, 1 assigned to you",
    );
  });

  it("shows the empty label and the load error", async () => {
    const { mocks } = renderInbox({ tickets: [] });
    expect(await screen.findByText("No tickets yet")).toBeTruthy();
    mocks.tickets.mockImplementationOnce(() => fail({ status: 500 }));
    cleanup();
    const failing = makeClient();
    failing.mocks.tickets.mockImplementation(() => fail({ status: 500 }));
    render(
      <SupportInbox client={failing.client} agents={AGENTS} pollInterval={0} />,
    );
    expect((await screen.findByRole("alert")).textContent).toBe(
      defaultInboxLabels.loadError,
    );
  });

  it("filters call the hook with the right params", async () => {
    const { mocks } = renderInbox();
    await screen.findByText("Login broken");
    expect(mocks.tickets).toHaveBeenLastCalledWith({ query: {} });

    fireEvent.change(screen.getByLabelText("Filter by status"), {
      target: { value: "pending" },
    });
    await waitFor(() =>
      expect(mocks.tickets).toHaveBeenLastCalledWith({
        query: { status: "pending" },
      }),
    );

    fireEvent.change(screen.getByLabelText("Filter by assignee"), {
      target: { value: "me" },
    });
    await waitFor(() =>
      expect(mocks.tickets).toHaveBeenLastCalledWith({
        query: { status: "pending", assignee: "me" },
      }),
    );

    fireEvent.change(screen.getByLabelText("Filter by assignee"), {
      target: { value: ALICE.id },
    });
    await waitFor(() =>
      expect(mocks.tickets).toHaveBeenLastCalledWith({
        query: { status: "pending", assignee: ALICE.id },
      }),
    );

    fireEvent.change(screen.getByLabelText("Filter by assignee"), {
      target: { value: "none" },
    });
    await waitFor(() =>
      expect(mocks.tickets).toHaveBeenLastCalledWith({
        query: { status: "pending", assignee: "none" },
      }),
    );

    await screen.findByRole("option", { name: "billing" });
    fireEvent.change(screen.getByLabelText("Filter by tag"), {
      target: { value: "billing" },
    });
    await waitFor(() =>
      expect(mocks.tickets).toHaveBeenLastCalledWith({
        query: { status: "pending", assignee: "none", tag: "billing" },
      }),
    );

    fireEvent.change(screen.getByLabelText("Search by number or subject"), {
      target: { value: "  refund " },
    });
    await waitFor(() =>
      expect(mocks.tickets).toHaveBeenLastCalledWith({
        query: {
          status: "pending",
          assignee: "none",
          tag: "billing",
          q: "refund",
        },
      }),
    );
  });

  it("the count chips toggle their filter", async () => {
    const { mocks } = renderInbox();
    await screen.findByText("Login broken");
    fireEvent.click(screen.getByRole("button", { name: "2 unassigned" }));
    await waitFor(() =>
      expect(mocks.tickets).toHaveBeenLastCalledWith({
        query: { assignee: "none" },
      }),
    );
    expect(
      screen
        .getByRole("button", { name: "2 unassigned" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "2 unassigned" }));
    await waitFor(() =>
      expect(mocks.tickets).toHaveBeenLastCalledWith({ query: {} }),
    );
  });

  it("loads more with the cursor", async () => {
    const { mocks } = renderInbox({ nextCursor: "cur1" });
    await screen.findByText("Login broken");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() =>
      expect(mocks.tickets).toHaveBeenCalledWith({ query: { cursor: "cur1" } }),
    );
  });
});

describe("bulk actions", () => {
  async function selectTwo() {
    const rendered = renderInbox();
    await screen.findByText("Login broken");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select ticket #1" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select ticket #3" }));
    expect(screen.getByText("2 selected")).toBeTruthy();
    return rendered;
  }

  it("updates status, priority and assignee for the selected ids", async () => {
    const { mocks } = await selectTwo();
    fireEvent.change(screen.getByLabelText("Set status…"), {
      target: { value: "solved" },
    });
    await waitFor(() =>
      expect(mocks.update).toHaveBeenLastCalledWith({
        ids: ["t1", "t3"],
        status: "solved",
      }),
    );
    fireEvent.change(screen.getByLabelText("Set priority…"), {
      target: { value: "urgent" },
    });
    await waitFor(() =>
      expect(mocks.update).toHaveBeenLastCalledWith({
        ids: ["t1", "t3"],
        priority: "urgent",
      }),
    );
    fireEvent.change(screen.getByLabelText("Set priority…"), {
      target: { value: "__none__" },
    });
    await waitFor(() =>
      expect(mocks.update).toHaveBeenLastCalledWith({
        ids: ["t1", "t3"],
        priority: null,
      }),
    );
    fireEvent.change(screen.getByLabelText("Assign to…"), {
      target: { value: BOB.id },
    });
    await waitFor(() =>
      expect(mocks.update).toHaveBeenLastCalledWith({
        ids: ["t1", "t3"],
        assigneeId: BOB.id,
      }),
    );
    fireEvent.change(screen.getByLabelText("Assign to…"), {
      target: { value: "__none__" },
    });
    await waitFor(() =>
      expect(mocks.update).toHaveBeenLastCalledWith({
        ids: ["t1", "t3"],
        assigneeId: null,
      }),
    );
  });

  it("adds and removes a tag", async () => {
    const { mocks } = await selectTwo();
    const input = screen.getByLabelText("Tag");
    fireEvent.change(input, { target: { value: "billing" } });
    fireEvent.click(screen.getByRole("button", { name: "Add tag" }));
    await waitFor(() =>
      expect(mocks.update).toHaveBeenLastCalledWith({
        ids: ["t1", "t3"],
        addTags: ["billing"],
      }),
    );
    fireEvent.change(input, { target: { value: "bug" } });
    fireEvent.click(screen.getByRole("button", { name: "Remove tag" }));
    await waitFor(() =>
      expect(mocks.update).toHaveBeenLastCalledWith({
        ids: ["t1", "t3"],
        removeTags: ["bug"],
      }),
    );
  });

  it("deletes after an inline confirmation, never window.confirm", async () => {
    const confirm = vi.fn();
    stub(window, "confirm", confirm);
    const { mocks } = await selectTwo();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("Delete 2 tickets");
    // Cancel keeps everything
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(mocks.delete).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, delete" }));
    await waitFor(() =>
      expect(mocks.delete).toHaveBeenCalledWith({ ids: ["t1", "t3"] }),
    );
    await waitFor(() => expect(screen.queryByText("2 selected")).toBeNull());
    expect(confirm).not.toHaveBeenCalled();
  });

  it("a bulk delete that includes the open ticket closes its thread", async () => {
    const { mocks } = await openTicket();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select ticket #1" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, delete" }));
    await waitFor(() =>
      expect(mocks.delete).toHaveBeenCalledWith({ ids: ["t1"] }),
    );
    await waitFor(() => expect(screen.queryByRole("log")).toBeNull());
  });

  it("a bulk delete of other tickets keeps the open thread", async () => {
    const { mocks } = await openTicket();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select ticket #3" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, delete" }));
    await waitFor(() =>
      expect(mocks.delete).toHaveBeenCalledWith({ ids: ["t3"] }),
    );
    await waitFor(() => expect(screen.queryByText("1 selected")).toBeNull());
    expect(screen.getByRole("log")).toBeTruthy();
  });

  it("select all and clear", async () => {
    renderInbox();
    await screen.findByText("Login broken");
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select all tickets" }),
    );
    expect(screen.getByText("3 selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(screen.queryByText("3 selected")).toBeNull();
  });
});

describe("thread", () => {
  it("shows replies, notes, timeline events and opens attachments", async () => {
    const messages = [
      message("m1"),
      message("m2", {
        kind: "note",
        authorType: "agent",
        author: { id: ALICE.id, name: "Alice", email: null, image: null },
        body: "Private remark",
      }),
      message("e1", {
        kind: "event",
        authorType: "system",
        author: null,
        body: "",
        data: { type: "status", from: "open", to: "pending" },
      }),
      message("e2", {
        kind: "event",
        authorType: "agent",
        body: "",
        data: { type: "assignee", from: null, to: BOB.id },
      }),
      message("e3", {
        kind: "event",
        body: "",
        data: { type: "priority", from: null, to: "high" },
      }),
      message("e4", { kind: "event", body: "", data: { type: "merged" } }),
    ];
    const { mocks } = await openTicket({
      messages,
      attachments: [
        attachment("a1", "m1"),
        attachment("a2", "m2", { internal: true }),
      ],
    });
    expect(screen.getByText("Words of m1")).toBeTruthy();
    expect(screen.getByText("Private remark")).toBeTruthy();
    // the note is marked and styled apart from replies
    const noteArticle = screen.getByText("Private remark").closest("article");
    expect(within(noteArticle as HTMLElement).getByText("Note")).toBeTruthy();
    expect(noteArticle?.className).toContain("border-dashed");
    expect(
      screen.getByText("Words of m1").closest("article")?.className,
    ).not.toContain("border-dashed");
    // timeline
    expect(
      screen.getByText(/Status changed from Open to Pending/),
    ).toBeTruthy();
    expect(screen.getByText(/Assigned to Bob/)).toBeTruthy();
    expect(screen.getByText(/Priority set to High/)).toBeTruthy();
    expect(screen.getByText(/Tickets merged/)).toBeTruthy();
    // attachments, internal ones marked
    expect(
      screen.getByRole("button", { name: "Open attachment a1.pdf" }),
    ).toBeTruthy();
    const internal = screen.getByRole("button", {
      name: "Open attachment a2.pdf",
    });
    expect(within(internal).getByText("Internal")).toBeTruthy();
    expect(within(internal).getByText("2 KB")).toBeTruthy();

    // open: GET through $fetch, then saved from a blob URL (revoked after)
    mocks.$fetch.mockImplementationOnce(() =>
      ok(new Blob(["x"], { type: "application/pdf" })),
    );
    const createObjectURL = vi.fn(() => "blob:test");
    const revokeObjectURL = vi.fn();
    stub(URL, "createObjectURL", createObjectURL);
    stub(URL, "revokeObjectURL", revokeObjectURL);
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    fireEvent.click(
      screen.getByRole("button", { name: "Open attachment a1.pdf" }),
    );
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(mocks.$fetch).toHaveBeenCalledWith("/support/agent/attachment", {
      method: "GET",
      query: { id: "a1" },
    });
    expect(createObjectURL).toHaveBeenCalled();
    await waitFor(
      () => expect(revokeObjectURL).toHaveBeenCalledWith("blob:test"),
      { timeout: 3000 },
    );
  });

  it("marks an unread ticket seen and refreshes the queue", async () => {
    const { mocks } = await openTicket({
      tickets: [ticket(1, { unread: true }), ticket(2)],
    });
    await waitFor(() =>
      expect(mocks.markSeen).toHaveBeenCalledWith({ id: "t1" }),
    );
  });

  it("renderMessage wraps every row with the fallback", async () => {
    const renderMessage = vi.fn((_m: unknown, fallback: React.ReactNode) => (
      <div data-testid="wrapped">{fallback}</div>
    ));
    await openTicket({}, { renderMessage });
    expect(renderMessage).toHaveBeenCalled();
    expect(renderMessage.mock.calls[0]?.[0]).toMatchObject({ id: "m1" });
    expect(screen.getByTestId("wrapped").textContent).toContain("Words of m1");
  });

  it("routes same-origin links in a message through onNavigate", async () => {
    const onNavigate = vi.fn();
    const href = `${window.location.origin}/orders/9?x=1`;
    await openTicket(
      { messages: [message("m1", { body: `See ${href} please` })] },
      { onNavigate },
    );
    const link = screen.getByRole("link", { name: href });
    expect(link.getAttribute("rel")).toContain("noopener");
    fireEvent.click(link);
    expect(onNavigate).toHaveBeenCalledWith("/orders/9?x=1");
  });

  it("Back returns to the queue and focuses the row", async () => {
    await openTicket();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.queryByRole("log")).toBeNull();
    await waitFor(() =>
      expect(document.activeElement?.textContent).toContain("Login broken"),
    );
  });
});

describe("composer", () => {
  it("sends a reply (internal false) and clears the draft", async () => {
    const { mocks } = await openTicket();
    write("  Hello customer ");
    fireEvent.click(sendButton());
    await waitFor(() =>
      expect(mocks.reply).toHaveBeenCalledWith({
        ticketId: "t1",
        body: "Hello customer",
        internal: false,
      }),
    );
    await waitFor(() => expect(textbox().value).toBe(""));
  });

  it("sends a note (internal true) with the chosen status", async () => {
    const { mocks } = await openTicket();
    fireEvent.click(screen.getByRole("radio", { name: "Internal note" }));
    fireEvent.change(screen.getByLabelText("Status after sending"), {
      target: { value: "solved" },
    });
    write("Check logs");
    fireEvent.click(sendButton());
    await waitFor(() =>
      expect(mocks.reply).toHaveBeenCalledWith({
        ticketId: "t1",
        body: "Check logs",
        internal: true,
        status: "solved",
      }),
    );
  });

  it("keeps the draft and shows one error when sending fails", async () => {
    const { mocks } = await openTicket();
    mocks.reply.mockImplementationOnce(() => fail({ status: 500 }));
    write("Hello");
    fireEvent.click(sendButton());
    expect((await screen.findByRole("alert")).textContent).toBe(
      defaultInboxLabels.sendFailed,
    );
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(textbox().value).toBe("Hello");
  });

  it("Ctrl+Enter sends, Enter alone does not, empty text cannot send", async () => {
    const { mocks } = await openTicket();
    expect((sendButton() as HTMLButtonElement).disabled).toBe(true);
    write("Hello");
    fireEvent.keyDown(textbox(), { key: "Enter" });
    expect(mocks.reply).not.toHaveBeenCalled();
    fireEvent.keyDown(textbox(), { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(mocks.reply).toHaveBeenCalledTimes(1));
    write("Again");
    fireEvent.keyDown(textbox(), { key: "Enter", metaKey: true });
    await waitFor(() => expect(mocks.reply).toHaveBeenCalledTimes(2));
  });

  it("uploads with internal matching the mode, and the toggle resets uploads", async () => {
    const { mocks } = await openTicket();
    const input = screen.getByTestId("support-inbox-file");
    const file = new File(["a"], "photo.png", { type: "image/png" });

    fireEvent.change(input, { target: { files: [file] } });
    expect(await screen.findByText("up1.png")).toBeTruthy();
    expect(mocks.$fetch).toHaveBeenLastCalledWith(
      "/support/agent/upload",
      expect.objectContaining({
        method: "POST",
        query: { ticketId: "t1", filename: "photo.png", internal: "false" },
      }),
    );

    // toggling to a note drops the reply's uploads
    fireEvent.click(screen.getByRole("radio", { name: "Internal note" }));
    await waitFor(() => expect(screen.queryByText("up1.png")).toBeNull());

    mocks.$fetch.mockImplementationOnce(() =>
      ok({ attachment: { id: "up2", filename: "up2.png", size: 100 } }),
    );
    fireEvent.change(input, { target: { files: [file] } });
    expect(await screen.findByText("up2.png")).toBeTruthy();
    expect(mocks.$fetch).toHaveBeenLastCalledWith(
      "/support/agent/upload",
      expect.objectContaining({
        query: { ticketId: "t1", filename: "photo.png", internal: "true" },
      }),
    );

    write("With file");
    fireEvent.click(sendButton());
    await waitFor(() =>
      expect(mocks.reply).toHaveBeenCalledWith({
        ticketId: "t1",
        body: "With file",
        internal: true,
        attachmentIds: ["up2"],
      }),
    );
    // sent: the list is empty again
    await waitFor(() => expect(screen.queryByText("up2.png")).toBeNull());
  });

  it("removes a pending upload", async () => {
    await openTicket();
    fireEvent.change(screen.getByTestId("support-inbox-file"), {
      target: { files: [new File(["a"], "photo.png", { type: "image/png" })] },
    });
    await screen.findByText("up1.png");
    fireEvent.click(screen.getByRole("button", { name: "Remove up1.png" }));
    expect(screen.queryByText("up1.png")).toBeNull();
  });

  it("shows an upload error", async () => {
    const { mocks } = await openTicket();
    mocks.$fetch.mockImplementationOnce(() => fail({ status: 413 }));
    fireEvent.change(screen.getByTestId("support-inbox-file"), {
      target: { files: [new File(["a"], "photo.png", { type: "image/png" })] },
    });
    expect((await screen.findByRole("alert")).textContent).toBe(
      defaultInboxLabels.uploadFailed,
    );
  });

  it("inserts a mention and sends the mentioned ids", async () => {
    const { mocks } = await openTicket();
    fireEvent.click(screen.getByRole("radio", { name: "Internal note" }));
    write("Please look");
    fireEvent.click(screen.getByRole("button", { name: "Mention" }));
    fireEvent.click(screen.getByRole("button", { name: "Mention Bob" }));
    expect(textbox().value).toContain("@Bob ");
    // the panel closed
    expect(screen.queryByRole("dialog", { name: "Mention" })).toBeNull();
    fireEvent.click(sendButton());
    await waitFor(() =>
      expect(mocks.reply).toHaveBeenCalledWith({
        ticketId: "t1",
        body: expect.stringContaining("@Bob"),
        internal: true,
        mentions: [BOB.id],
      }),
    );
  });

  it("does not send a mention whose @name was deleted", async () => {
    const { mocks } = await openTicket();
    fireEvent.click(screen.getByRole("button", { name: "Mention" }));
    fireEvent.click(screen.getByRole("button", { name: "Mention Alice" }));
    write("never mind");
    fireEvent.click(sendButton());
    await waitFor(() => expect(mocks.reply).toHaveBeenCalled());
    expect(mocks.reply.mock.calls[0]?.[0]).not.toHaveProperty("mentions");
  });
});

describe("canned replies", () => {
  it("inserts the text into the composer", async () => {
    await openTicket();
    write("Dear Cora,");
    textbox().setSelectionRange(10, 10);
    fireEvent.click(
      await screen.findByRole("button", { name: "Canned replies" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: /Greeting/ }));
    expect(textbox().value).toBe("Dear Cora,Hello, thanks for writing");
    expect(screen.queryByRole("dialog", { name: "Canned replies" })).toBeNull();
    expect(document.activeElement).toBe(textbox());
  });

  it("filters the list by the search box", async () => {
    await openTicket({
      canned: [
        { id: "c1", title: "Greeting", body: "Hello there" },
        { id: "c2", title: "Farewell", body: "Goodbye now" },
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: "Canned replies" }));
    await screen.findByText("Farewell");
    fireEvent.change(screen.getByLabelText("Search canned replies"), {
      target: { value: "greet" },
    });
    expect(screen.queryByText("Farewell")).toBeNull();
    expect(screen.getByText("Greeting")).toBeTruthy();
  });

  it("manages: create, edit, delete", async () => {
    const { mocks } = await openTicket();
    fireEvent.click(screen.getByRole("button", { name: "Canned replies" }));
    await screen.findByText("Greeting");
    fireEvent.click(screen.getByRole("button", { name: "Manage" }));

    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Bye" },
    });
    fireEvent.change(screen.getByLabelText("Text"), {
      target: { value: "See you" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save canned reply" }));
    await waitFor(() =>
      expect(mocks.cannedSave).toHaveBeenCalledWith({
        title: "Bye",
        body: "See you",
      }),
    );

    // edit the existing one
    fireEvent.click(screen.getByRole("button", { name: /^Greeting/ }));
    fireEvent.change(screen.getByLabelText("Text"), {
      target: { value: "Hi all" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save canned reply" }));
    await waitFor(() =>
      expect(mocks.cannedSave).toHaveBeenLastCalledWith({
        id: "c1",
        title: "Greeting",
        body: "Hi all",
      }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Delete canned reply Greeting" }),
    );
    await waitFor(() =>
      expect(mocks.cannedDelete).toHaveBeenCalledWith({ id: "c1" }),
    );
  });

  it("has no management when the client lacks it", async () => {
    await openTicket({ cannedManage: false });
    fireEvent.click(screen.getByRole("button", { name: "Canned replies" }));
    await screen.findByText("Greeting");
    expect(screen.queryByRole("button", { name: "Manage" })).toBeNull();
  });

  it("hides management once the server forbids it", async () => {
    const { mocks } = await openTicket();
    mocks.cannedSave.mockImplementationOnce(() =>
      fail({ status: 403, code: "NOT_ALLOWED" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Canned replies" }));
    await screen.findByText("Greeting");
    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Bye" },
    });
    fireEvent.change(screen.getByLabelText("Text"), {
      target: { value: "See you" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save canned reply" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Manage" })).toBeNull(),
    );
    // still usable for inserting
    expect(screen.getByText("Greeting")).toBeTruthy();
    expect(screen.queryByLabelText("Title")).toBeNull();
  });

  it("hides the picker when listing is forbidden", async () => {
    const made = makeClient();
    made.mocks.canned.mockImplementation(() => fail({ status: 403 }));
    render(
      <SupportInbox client={made.client} agents={AGENTS} pollInterval={0} />,
    );
    await screen.findByText("Login broken");
    fireEvent.click(screen.getByRole("button", { name: /Login broken/ }));
    await screen.findByRole("log");
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Canned replies" }),
      ).toBeNull(),
    );
  });
});

describe("side panel", () => {
  const panel = () =>
    within(screen.getByRole("complementary", { name: "Details" }));

  it("status, priority and assignee changes call update", async () => {
    const { mocks } = await openTicket();
    fireEvent.change(panel().getByLabelText("Status"), {
      target: { value: "solved" },
    });
    await waitFor(() =>
      expect(mocks.update).toHaveBeenLastCalledWith({
        ids: ["t1"],
        status: "solved",
      }),
    );
    fireEvent.change(panel().getByLabelText("Priority"), {
      target: { value: "urgent" },
    });
    await waitFor(() =>
      expect(mocks.update).toHaveBeenLastCalledWith({
        ids: ["t1"],
        priority: "urgent",
      }),
    );
    fireEvent.change(panel().getByLabelText("Priority"), {
      target: { value: "" },
    });
    await waitFor(() =>
      expect(mocks.update).toHaveBeenLastCalledWith({
        ids: ["t1"],
        priority: null,
      }),
    );
    fireEvent.change(panel().getByLabelText("Assignee"), {
      target: { value: ALICE.id },
    });
    await waitFor(() =>
      expect(mocks.update).toHaveBeenLastCalledWith({
        ids: ["t1"],
        assigneeId: ALICE.id,
      }),
    );
    fireEvent.change(panel().getByLabelText("Assignee"), {
      target: { value: "" },
    });
    await waitFor(() =>
      expect(mocks.update).toHaveBeenLastCalledWith({
        ids: ["t1"],
        assigneeId: null,
      }),
    );
  });

  it("adds and removes tags", async () => {
    const { mocks } = await openTicket({
      tickets: [ticket(1, { tags: ["billing"] }), ticket(2)],
    });
    fireEvent.click(
      panel().getByRole("button", { name: "Remove tag billing" }),
    );
    await waitFor(() =>
      expect(mocks.update).toHaveBeenLastCalledWith({
        ids: ["t1"],
        removeTags: ["billing"],
      }),
    );
    fireEvent.change(panel().getByLabelText("Tag"), {
      target: { value: "bug" },
    });
    fireEvent.click(panel().getByRole("button", { name: "Add tag" }));
    await waitFor(() =>
      expect(mocks.update).toHaveBeenLastCalledWith({
        ids: ["t1"],
        addTags: ["bug"],
      }),
    );
  });

  it("refreshes the queue after a change", async () => {
    const { mocks } = await openTicket();
    const before = mocks.tickets.mock.calls.length;
    fireEvent.change(panel().getByLabelText("Status"), {
      target: { value: "pending" },
    });
    await waitFor(() =>
      expect(mocks.tickets.mock.calls.length).toBeGreaterThan(before),
    );
  });

  it("deletes the ticket after a confirmation and closes the thread", async () => {
    const { mocks } = await openTicket();
    fireEvent.click(panel().getByRole("button", { name: "Delete ticket" }));
    expect(screen.getByRole("alertdialog").textContent).toContain(
      "Delete this ticket",
    );
    fireEvent.click(screen.getByRole("button", { name: "Yes, delete" }));
    await waitFor(() =>
      expect(mocks.delete).toHaveBeenCalledWith({ ids: ["t1"] }),
    );
    await waitFor(() => expect(screen.queryByRole("log")).toBeNull());
  });
});

describe("merge", () => {
  const mergeOptions = (extra: Options = {}): Options => ({
    ticketsFor: (query) =>
      query?.q === "2" ? [ticket(2)] : [ticket(1), ticket(2), ticket(3)],
    ...extra,
  });

  it("is hidden when features.merge is false", async () => {
    await openTicket({ features: { attachments: true, merge: false } });
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
  });

  it("is hidden when the client has no merge", async () => {
    await openTicket({ merge: false });
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
  });

  it("finds a target by number, confirms inline and merges", async () => {
    const { mocks } = await openTicket(mergeOptions());
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    const dialog = await screen.findByRole("dialog", { name: "Merge" });
    fireEvent.change(
      within(dialog).getByLabelText("Search by number or subject"),
      {
        target: { value: "2" },
      },
    );
    await waitFor(() =>
      expect(mocks.tickets).toHaveBeenCalledWith({ query: { q: "2" } }),
    );
    // the ticket itself is never offered
    const target = await within(dialog).findByRole("button", {
      name: "Merge into #2: Printer jam",
    });
    await waitFor(() =>
      expect(
        within(dialog).queryByRole("button", { name: /Merge into #1/ }),
      ).toBeNull(),
    );
    fireEvent.click(target);
    expect(screen.getByRole("alertdialog").textContent).toContain(
      "Merge #1 into #2",
    );
    expect(mocks.merge).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Yes, merge" }));
    await waitFor(() =>
      expect(mocks.merge).toHaveBeenCalledWith({
        sourceId: "t1",
        targetId: "t2",
      }),
    );
    // the thread follows the target
    await waitFor(() =>
      expect(mocks.ticket).toHaveBeenLastCalledWith({ query: { id: "t2" } }),
    );
  });
});

describe("attachments feature flag", () => {
  const attachmentOptions: Options = {
    attachments: [attachment("a1", "m1")],
  };

  it("hides every attachment control when features.attachments is false", async () => {
    await openTicket({
      ...attachmentOptions,
      features: { attachments: false, merge: true },
    });
    expect(screen.queryByRole("button", { name: "Attach file" })).toBeNull();
    expect(screen.queryByTestId("support-inbox-file")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Open attachment/ }),
    ).toBeNull();
  });

  it("shows them when it is true", async () => {
    await openTicket(attachmentOptions);
    expect(screen.getByRole("button", { name: "Attach file" })).toBeTruthy();
    expect(screen.getByTestId("support-inbox-file")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Open attachment a1.pdf" }),
    ).toBeTruthy();
  });
});

describe("keyboard and popovers", () => {
  it("Escape closes a picker and returns focus to its button", async () => {
    await openTicket();
    const trigger = screen.getByRole("button", { name: "Mention" });
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Mention" })).toBeTruthy();
    // focus moved into the panel
    expect(
      screen
        .getByRole("dialog", { name: "Mention" })
        .contains(document.activeElement),
    ).toBe(true);
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    expect(screen.queryByRole("dialog", { name: "Mention" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("an outside press closes a picker", async () => {
    await openTicket();
    fireEvent.click(
      await screen.findByRole("button", { name: "Canned replies" }),
    );
    expect(screen.getByRole("dialog", { name: "Canned replies" })).toBeTruthy();
    // a press inside stays open
    fireEvent.mouseDown(screen.getByLabelText("Search canned replies"));
    expect(screen.getByRole("dialog", { name: "Canned replies" })).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("dialog", { name: "Canned replies" })).toBeNull();
  });

  it("arrow keys move between picker items", async () => {
    await openTicket();
    fireEvent.click(screen.getByRole("button", { name: "Mention" }));
    const alice = screen.getByRole("button", { name: "Mention Alice" });
    const bob = screen.getByRole("button", { name: "Mention Bob" });
    alice.focus();
    fireEvent.keyDown(alice, { key: "ArrowDown" });
    expect(document.activeElement).toBe(bob);
    fireEvent.keyDown(bob, { key: "ArrowUp" });
    expect(document.activeElement).toBe(alice);
  });

  it("Escape and an outside press cancel a delete confirmation", async () => {
    const { mocks } = await openTicket();
    fireEvent.click(screen.getByRole("button", { name: "Delete ticket" }));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Delete ticket" }));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it("the composer's controls are in a sensible Tab order", async () => {
    await openTicket();
    const group = screen.getByRole("group", { name: "Message type" });
    const composer = group.parentElement as HTMLElement;
    const order = Array.from(
      composer.querySelectorAll<HTMLElement>(
        "input:not([hidden]):not([type=file]), textarea, select, button",
      ),
    ).map(
      (el) =>
        el.getAttribute("aria-label") ??
        el.closest("label")?.textContent ??
        el.textContent,
    );
    expect(order).toEqual([
      "Reply",
      "Internal note",
      "Write a message",
      "Canned replies",
      "Mention",
      "Attach file",
      "Status after sending",
      "Send",
    ]);
    // nothing in it takes focus out of order
    for (const el of composer.querySelectorAll("[tabindex]")) {
      expect(Number(el.getAttribute("tabindex"))).toBeLessThanOrEqual(0);
    }
  });

  it("the queue's filters come before its rows in Tab order", async () => {
    renderInbox();
    await screen.findByText("Login broken");
    const queue = screen.getByRole("region", { name: "Queue" });
    const order = Array.from(
      queue.querySelectorAll<HTMLElement>("input, select, button"),
    ).map((el) => el.getAttribute("aria-label") ?? el.textContent);
    expect(order.slice(0, 4)).toEqual([
      "3 open",
      "1 pending",
      "2 unassigned",
      "1 mine",
    ]);
    expect(order.indexOf("Search by number or subject")).toBeLessThan(
      order.indexOf("Select ticket #1"),
    );
    expect(order.indexOf("Filter by tag")).toBeLessThan(
      order.indexOf("Select ticket #1"),
    );
  });
});

describe("labels", () => {
  it("every visible string comes from labels", async () => {
    renderInbox();
    await screen.findByText("Login broken");
    fireEvent.click(screen.getByRole("button", { name: /Login broken/ }));
    await screen.findByRole("log");
    // an override shows up in the queue and the thread
    cleanup();

    const labels: Partial<SupportLabels & SupportInboxLabels> = {
      queue: "Inbox of agents",
      send: "Dispatch",
      empty: "Nothing here",
      back: "Go back",
      reply: "Public answer",
      internalNote: "Staff memo",
      status: {
        open: "Active",
        pending: "Waiting",
        solved: "Done",
        closed: "Shut",
      },
      ticketNumber: (n) => `No. ${n}`,
      relativeTime: () => "moments ago",
      countOpen: (n) => `${n} active`,
      cannedReplies: "Snippets",
      mention: "Ping",
      merge: "Combine",
    };
    renderInbox({}, { labels });
    await screen.findByText("Login broken");
    expect(
      screen.getByRole("region", { name: "Inbox of agents" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "3 active" })).toBeTruthy();
    expect(screen.getAllByText(/moments ago/).length).toBeGreaterThan(0);
    expect(screen.getByRole("option", { name: "Waiting" })).toBeTruthy();
    expect(screen.getAllByText("No. 1").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /Login broken/ }));
    await screen.findByRole("log");
    expect(screen.getByRole("button", { name: "Dispatch" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Go back" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Staff memo" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Public answer" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Snippets" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ping" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Combine" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
  });

  it("the empty and error states use their labels", async () => {
    renderInbox({ tickets: [] }, { labels: { empty: "Nothing here" } });
    expect(await screen.findByText("Nothing here")).toBeTruthy();
    cleanup();
    const failing = makeClient();
    failing.mocks.tickets.mockImplementation(() => fail({ status: 500 }));
    render(
      <SupportInbox
        client={failing.client}
        agents={AGENTS}
        pollInterval={0}
        labels={{ loadError: "Boom", selectPrompt: "Pick one" }}
      />,
    );
    expect((await screen.findByRole("alert")).textContent).toBe("Boom");
    expect(screen.getByText("Pick one")).toBeTruthy();
  });

  it("no default English is left when every label is overridden", async () => {
    // every leaf of every label becomes a marker
    // lowercase, so a marker never contains a capitalised default word
    const marker = (path: string) => `Ω${path.toLowerCase()}`;
    const overrides: Record<string, unknown> = {};
    const defaults: Record<string, unknown> = {
      ...defaultLabels,
      ...defaultInboxLabels,
    };
    const english: string[] = [];
    for (const [key, value] of Object.entries(defaults)) {
      if (typeof value === "string") {
        english.push(value);
        overrides[key] = marker(key);
      } else if (typeof value === "function") {
        overrides[key] =
          key === "relativeTime"
            ? () => "Ωtime"
            : (...args: unknown[]) =>
                `Ω${key.toLowerCase()}(${args.map((a) => JSON.stringify(a)).join(",")})`;
      } else {
        const record: Record<string, string> = {};
        for (const [name, text] of Object.entries(
          value as Record<string, string>,
        )) {
          english.push(text);
          record[name] = marker(`${key}.${name}`);
        }
        overrides[key] = record;
      }
    }
    const made = makeClient({
      messages: [
        message("m1", { verified: false }),
        message("m2", {
          kind: "note",
          authorType: "agent",
          author: null,
          body: "Private remark",
        }),
        message("m3", { authorType: "system", author: null }),
        message("e1", {
          kind: "event",
          body: "",
          data: { type: "status", from: "open", to: "solved" },
        }),
        message("e2", {
          kind: "event",
          body: "",
          data: { type: "assignee", to: null },
        }),
        message("e3", {
          kind: "event",
          body: "",
          data: { type: "priority", to: null },
        }),
        message("e4", { kind: "event", body: "", data: { type: "merged" } }),
        message("e5", {
          kind: "event",
          body: "",
          data: { type: "attachment_dropped" },
        }),
        message("e6", {
          kind: "event",
          body: "",
          data: { type: "followup_of" },
        }),
      ],
      attachments: [attachment("a1", "m1", { internal: true })],
      tickets: [
        ticket(1, {
          unread: true,
          tags: ["billing"],
          priority: "high",
          assigneeId: ALICE.id,
        }),
        ticket(2),
      ],
      nextCursor: "more",
    });
    render(
      <SupportInbox
        client={made.client}
        agents={AGENTS}
        pollInterval={0}
        labels={overrides as Partial<SupportLabels & SupportInboxLabels>}
      />,
    );

    const leaks = () => {
      const text = document.body.textContent ?? "";
      const attributes = Array.from(
        document.querySelectorAll("[aria-label], [placeholder]"),
      ).flatMap((el) => [
        el.getAttribute("aria-label") ?? "",
        el.getAttribute("placeholder") ?? "",
      ]);
      const haystack = [text, ...attributes].join("\n");
      return english.filter(
        (word) => word.length >= 3 && haystack.includes(word),
      );
    };

    await screen.findByText("Login broken");
    // bulk bar, delete confirmation
    fireEvent.click(
      screen.getAllByRole("checkbox", {
        name: /Ωselectticket/,
      })[0] as HTMLElement,
    );
    fireEvent.click(screen.getByRole("button", { name: marker("delete") }));
    expect(leaks()).toEqual([]);
    fireEvent.click(
      screen.getByRole("button", { name: marker("clearSelection") }),
    );

    // thread: messages, events, attachment, details
    fireEvent.click(screen.getByRole("button", { name: /Login broken/ }));
    await screen.findByRole("log");
    expect(
      screen.getByRole("button", { name: /Ωopenattachment/ }),
    ).toBeTruthy();
    expect(leaks()).toEqual([]);

    // failed send and failed upload
    made.mocks.reply.mockImplementationOnce(() => fail({ status: 500 }));
    fireEvent.change(
      screen.getByRole("textbox", { name: marker("composerLabel") }),
      { target: { value: "Hi" } },
    );
    fireEvent.click(screen.getByRole("button", { name: marker("send") }));
    await screen.findByText(marker("sendFailed"));
    made.mocks.$fetch.mockImplementationOnce(() => fail({ status: 500 }));
    fireEvent.change(screen.getByTestId("support-inbox-file"), {
      target: { files: [new File(["a"], "x.png", { type: "image/png" })] },
    });
    await screen.findByText(marker("uploadFailed"));
    expect(leaks()).toEqual([]);

    // pickers
    fireEvent.click(
      screen.getByRole("button", { name: marker("cannedReplies") }),
    );
    await screen.findByText("Greeting");
    fireEvent.click(
      screen.getByRole("button", { name: marker("cannedManage") }),
    );
    expect(leaks()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: marker("mention") }));
    expect(leaks()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: marker("merge") }));
    await screen.findByRole("dialog", { name: marker("merge") });
    await screen.findByRole("button", { name: /Ωmergeinto/ });
    fireEvent.click(screen.getByRole("button", { name: /Ωmergeinto/ }));
    expect(leaks()).toEqual([]);

    // back to the queue
    fireEvent.click(screen.getByRole("button", { name: marker("back") }));
    expect(leaks()).toEqual([]);
  });
});

describe("class props", () => {
  it("className and the per-part class props reach their parts", async () => {
    const { container } = await openTicket(
      { nextCursor: "more" },
      {
        className: "root-x",
        queueClassName: "queue-x",
        threadClassName: "thread-x",
        messageClassName: "message-x",
        composerClassName: "composer-x",
        buttonClassName: "button-x",
      },
    );
    expect((container.firstElementChild as HTMLElement).className).toContain(
      "root-x",
    );
    expect(screen.getByRole("region", { name: "Queue" }).className).toContain(
      "queue-x",
    );
    expect(
      screen.getByRole("region", { name: "Login broken" }).className,
    ).toContain("thread-x");
    expect(
      screen.getByText("Words of m1").closest("article")?.className,
    ).toContain("message-x");
    expect(
      screen.getByRole("group", { name: "Message type" }).parentElement
        ?.className,
    ).toContain("composer-x");
    expect(sendButton().className).toContain("button-x");
    expect(
      screen.getByRole("button", { name: "Load more" }).className,
    ).toContain("button-x");
  });

  it("keeps popover panels inside a narrow screen", async () => {
    const { container } = await openTicket();
    // nothing on the root clips an overflowing panel
    expect(
      (container.firstElementChild as HTMLElement).className,
    ).not.toContain("overflow-hidden");
    // composer pickers hang from the toolbar row and span it on a phone
    fireEvent.click(screen.getByRole("button", { name: "Mention" }));
    const mention = screen.getByRole("dialog", { name: "Mention" });
    expect(mention.className).toContain("right-0");
    expect(mention.parentElement?.className).not.toContain("relative");
    expect(mention.parentElement?.parentElement?.className).toContain(
      "relative",
    );
    fireEvent.mouseDown(document.body);
    // the merge panel sits in the flow of the (scrolling) side panel
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    const merge = await screen.findByRole("dialog", { name: "Merge" });
    expect(merge.className).not.toContain("absolute");
    expect(merge.className).toContain("w-full");
  });

  it("uses no fixed width above 360px in any layout class", async () => {
    const { container } = await openTicket({
      attachments: [attachment("a1", "m1")],
    });
    // open every popover so their panels are included
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    const widths: string[] = [];
    const collect = () => {
      for (const el of container.querySelectorAll("[class]")) {
        for (const token of el.getAttribute("class")?.split(/\s+/) ?? []) {
          const base = token.slice(token.lastIndexOf(":") + 1);
          const scale = /^(?:min-|max-)?w-(\d+(?:\.\d+)?)$/.exec(base);
          if (scale && Number(scale[1]) * 4 > 360) widths.push(token);
          const px = /^(?:min-|max-)?w-\[(\d+(?:\.\d+)?)px\]$/.exec(base);
          if (px && Number(px[1]) > 360) widths.push(token);
          const rem = /^(?:min-|max-)?w-\[(\d+(?:\.\d+)?)rem\]$/.exec(base);
          if (rem && Number(rem[1]) * 16 > 360) widths.push(token);
        }
      }
    };
    collect();
    fireEvent.mouseDown(document.body);
    fireEvent.click(screen.getByRole("button", { name: "Canned replies" }));
    collect();
    expect(widths).toEqual([]);
  });
});
