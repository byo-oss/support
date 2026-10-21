// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { type ReactNode, useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupportFetchClient } from "../hooks";
import { defaultLabels } from "../labels";
import { SupportWidget, type SupportWidgetProps } from ".";
import { defaultWidgetLabels } from "./labels";

const ok = <T,>(data: T) => Promise.resolve({ data, error: null });
const failure = (error: unknown = new Error("boom")) =>
  Promise.resolve({ data: null, error });

const NOW = new Date().toISOString();

function ticket(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    number: id === "t2" ? 2 : 1,
    subject: `Subject ${id}`,
    status: "open",
    priority: null,
    channel: "web",
    organizationId: null,
    visibility: "private",
    rating: null,
    createdAt: NOW,
    updatedAt: NOW,
    lastMessageAt: NOW,
    solvedAt: null,
    unread: false,
    isRequester: true,
    ...extra,
  };
}

function message(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    ticketId: "t1",
    kind: "reply",
    authorType: "agent",
    author: { name: "Ada", image: null },
    body: `Body ${id}`,
    data: null,
    createdAt: NOW,
    ...extra,
  };
}

function attachment(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    ticketId: "t1",
    messageId: "m1",
    filename: "report.pdf",
    contentType: "application/pdf",
    size: 2048,
    createdAt: NOW,
    ...extra,
  };
}

type Setup = {
  tickets?: unknown[];
  detail?: { ticket?: unknown; messages?: unknown[]; attachments?: unknown[] };
  attachments?: boolean;
  nextCursor?: string | null;
};

function makeClient(setup: Setup = {}) {
  const mocks = {
    createTicket: vi.fn((_input: unknown) => ok({ ticket: ticket("new") })),
    myTickets: vi.fn((_input?: unknown) =>
      ok({
        tickets: setup.tickets ?? [ticket("t1"), ticket("t2")],
        nextCursor: setup.nextCursor ?? null,
        features: { attachments: setup.attachments ?? true },
      }),
    ),
    ticket: vi.fn((_input: unknown) =>
      ok({
        ticket: setup.detail?.ticket ?? ticket("t1"),
        messages: setup.detail?.messages ?? [message("m1")],
        attachments: setup.detail?.attachments ?? [],
      }),
    ),
    reply: vi.fn((_input: unknown) => ok({ message: message("m2") })),
    updateMine: vi.fn((_input: unknown) => ok({ ticket: ticket("t1") })),
    markSeen: vi.fn((_input: unknown) => ok({ ok: true })),
    $fetch: vi.fn(
      (
        _path: string,
        _options: unknown,
      ): Promise<{ data: unknown; error: unknown }> =>
        ok({
          attachment: attachment("up1", {
            filename: "photo.png",
            messageId: null,
          }),
        }),
    ),
  };
  const client = {
    support: {
      createTicket: mocks.createTicket,
      myTickets: mocks.myTickets,
      ticket: mocks.ticket,
      reply: mocks.reply,
      updateMine: mocks.updateMine,
      markSeen: mocks.markSeen,
      agent: {},
    },
    $fetch: mocks.$fetch,
  } as unknown as SupportFetchClient;
  return { client, mocks };
}

function renderWidget(
  setup: Setup = {},
  props: Partial<SupportWidgetProps> = {},
) {
  const { client, mocks } = makeClient(setup);
  const view = render(
    <SupportWidget
      client={client}
      pollInterval={0}
      badgePollInterval={0}
      {...props}
    />,
  );
  return { ...view, client, mocks };
}

const trigger = () => screen.getByRole("button", { name: "Support" });

async function openPanel() {
  fireEvent.click(trigger());
  await screen.findByRole("dialog");
}

async function openThread(subject = "Subject t1") {
  await openPanel();
  fireEvent.click(
    await screen.findByRole("button", { name: new RegExp(subject) }),
  );
  await screen.findByRole("heading", { name: new RegExp(subject) });
}

const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => "blob:fake");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
});

describe("SupportWidget list", () => {
  it("lists my tickets with status, unread and relative time from labels", async () => {
    renderWidget(
      {
        tickets: [
          ticket("t1", { unread: true, status: "pending" }),
          ticket("t2", { status: "solved" }),
        ],
      },
      { labels: { relativeTime: () => "moments ago" } },
    );
    await openPanel();

    expect(screen.getByRole("heading", { name: "My tickets" })).toBeTruthy();
    const rows = await screen.findAllByRole("listitem");
    expect(rows).toHaveLength(2);
    // statuses read in the customer's words
    expect(
      within(rows[0] as HTMLElement).getByText("Awaiting your reply"),
    ).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText("Unread")).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText("Solved")).toBeTruthy();
    expect(screen.getAllByText("moments ago")).toHaveLength(2);
    expect(screen.getByText("#1")).toBeTruthy();
  });

  it("shows loading, empty and error states", async () => {
    const { client, mocks } = makeClient({ tickets: [] });
    const releases: Array<(value: unknown) => void> = [];
    mocks.myTickets.mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(resolve);
        }) as never,
    );
    render(<SupportWidget client={client} pollInterval={0} />);
    await openPanel();
    expect(screen.getByText("Loading…")).toBeTruthy();
    for (const release of releases) {
      release({
        data: {
          tickets: [],
          nextCursor: null,
          features: { attachments: true },
        },
        error: null,
      });
    }
    expect(await screen.findByText("No tickets yet")).toBeTruthy();

    mocks.myTickets.mockImplementation(() => failure() as never);
    fireEvent.keyDown(document, { key: "Escape" });
    await openPanel();
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("Something went wrong. Try again.")).toBeTruthy();
  });

  it("loads more tickets", async () => {
    const { mocks } = renderWidget({ nextCursor: "c1" });
    await openPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    await waitFor(() =>
      expect(mocks.myTickets).toHaveBeenCalledWith({
        query: { cursor: "c1" },
      }),
    );
  });

  it("does not filter the list by organizationId", async () => {
    const { mocks } = renderWidget({}, { organizationId: "org1" });
    await openPanel();
    await screen.findByText(/Subject t1/);
    for (const call of mocks.myTickets.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("org1");
    }
  });
});

describe("SupportWidget new ticket", () => {
  async function openForm() {
    await openPanel();
    fireEvent.click(await screen.findByRole("button", { name: "New ticket" }));
    await screen.findByLabelText("Subject");
  }

  it("creates a ticket and opens its thread", async () => {
    const { mocks } = renderWidget();
    await openForm();
    const submit = screen.getByRole("button", { name: "Submit ticket" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Subject"), {
      target: { value: "  Printer  " },
    });
    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "It is on fire" },
    });
    fireEvent.click(submit);

    await waitFor(() =>
      expect(mocks.createTicket).toHaveBeenCalledWith({
        subject: "Printer",
        body: "It is on fire",
      }),
    );
    await waitFor(() =>
      expect(mocks.ticket).toHaveBeenCalledWith({ query: { id: "new" } }),
    );
  });

  it("submits with Enter in the subject and Ctrl+Enter in the message", async () => {
    const { mocks } = renderWidget();
    await openForm();
    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "Body" },
    });
    fireEvent.change(screen.getByLabelText("Subject"), {
      target: { value: "Subject" },
    });
    fireEvent.keyDown(screen.getByLabelText("Subject"), { key: "Enter" });
    await waitFor(() => expect(mocks.createTicket).toHaveBeenCalledTimes(1));

    cleanup();
    const second = renderWidget();
    await openForm();
    fireEvent.change(screen.getByLabelText("Subject"), {
      target: { value: "Subject" },
    });
    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "Body" },
    });
    fireEvent.keyDown(screen.getByLabelText("Message"), {
      key: "Enter",
      ctrlKey: true,
    });
    await waitFor(() =>
      expect(second.mocks.createTicket).toHaveBeenCalledTimes(1),
    );
  });

  it("offers the share toggle only with an organization", async () => {
    renderWidget();
    await openForm();
    expect(screen.queryByLabelText("Share with my organization")).toBeNull();
    cleanup();

    const { mocks } = renderWidget({}, { organizationId: "org1" });
    await openForm();
    fireEvent.change(screen.getByLabelText("Subject"), {
      target: { value: "S" },
    });
    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "B" },
    });
    fireEvent.click(screen.getByLabelText("Share with my organization"));
    fireEvent.click(screen.getByRole("button", { name: "Submit ticket" }));
    await waitFor(() =>
      expect(mocks.createTicket).toHaveBeenCalledWith({
        subject: "S",
        body: "B",
        organizationId: "org1",
        visibility: "organization",
      }),
    );
  });

  it("keeps the form and shows an error when creating fails", async () => {
    const { mocks } = renderWidget();
    mocks.createTicket.mockImplementationOnce(() => failure() as never);
    await openForm();
    fireEvent.change(screen.getByLabelText("Subject"), {
      target: { value: "S" },
    });
    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "B" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit ticket" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect((screen.getByLabelText("Subject") as HTMLInputElement).value).toBe(
      "S",
    );
  });
});

describe("SupportWidget thread", () => {
  it("renders customer-visible messages and event rows", async () => {
    renderWidget({
      detail: {
        messages: [
          message("m1"),
          message("m2", {
            kind: "event",
            authorType: "system",
            author: null,
            body: "",
            data: { type: "status", from: "open", to: "solved" },
          }),
          message("m3", { kind: "event", data: { type: "merged" } }),
          message("m4", { authorType: "customer", author: null }),
        ],
      },
    });
    await openThread();
    expect(screen.getByText("Body m1")).toBeTruthy();
    expect(screen.getByText("Ada")).toBeTruthy();
    expect(
      screen.getByText(/Status changed from With our team to Solved/),
    ).toBeTruthy();
    expect(screen.getByText(/duplicate ticket was merged/)).toBeTruthy();
    expect(screen.getByText("Someone")).toBeTruthy();
  });

  it("replies with the box and clears it", async () => {
    const { mocks } = renderWidget();
    await openThread();
    const box = screen.getByLabelText("Reply") as HTMLTextAreaElement;
    const send = screen.getByRole("button", {
      name: "Send",
    }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(box, { target: { value: "Thanks" } });
    fireEvent.click(send);
    await waitFor(() =>
      expect(mocks.reply).toHaveBeenCalledWith({
        ticketId: "t1",
        body: "Thanks",
      }),
    );
    await waitFor(() => expect(box.value).toBe(""));
  });

  it("replies with Ctrl+Enter in the box", async () => {
    const { mocks } = renderWidget();
    await openThread();
    const box = screen.getByLabelText("Reply");
    fireEvent.change(box, { target: { value: "Quick" } });
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    await waitFor(() => expect(mocks.reply).toHaveBeenCalledTimes(1));
  });

  it("keeps the text when a reply fails", async () => {
    const { mocks } = renderWidget();
    mocks.reply.mockImplementationOnce(() => failure() as never);
    await openThread();
    const box = screen.getByLabelText("Reply") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "Keep me" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(box.value).toBe("Keep me");
  });

  it("solves an open ticket, and reopens a solved one", async () => {
    const open = renderWidget();
    await openThread();
    expect(screen.queryByRole("button", { name: "Reopen" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Mark solved" }));
    await waitFor(() =>
      expect(open.mocks.updateMine).toHaveBeenCalledWith({
        id: "t1",
        status: "solved",
      }),
    );
    cleanup();

    const solved = renderWidget({
      detail: { ticket: ticket("t1", { status: "solved" }) },
    });
    await openThread();
    expect(screen.queryByRole("button", { name: "Mark solved" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    await waitFor(() =>
      expect(solved.mocks.updateMine).toHaveBeenCalledWith({
        id: "t1",
        status: "open",
      }),
    );
  });

  it("takes no replies on a closed ticket", async () => {
    renderWidget({ detail: { ticket: ticket("t1", { status: "closed" }) } });
    await openThread();
    expect(screen.getByText("This ticket is closed.")).toBeTruthy();
    expect(screen.queryByLabelText("Reply")).toBeNull();
    expect(screen.queryByRole("button", { name: "Mark solved" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reopen" })).toBeNull();
  });

  it("rates good or bad, and shows the current rating", async () => {
    const { mocks } = renderWidget({
      detail: { ticket: ticket("t1", { status: "solved", rating: "bad" }) },
    });
    await openThread();
    const good = screen.getByRole("button", { name: "Good" });
    const bad = screen.getByRole("button", { name: "Bad" });
    expect(bad.getAttribute("aria-pressed")).toBe("true");
    expect(good.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(bad);
    expect(mocks.updateMine).not.toHaveBeenCalled();
    fireEvent.click(good);
    await waitFor(() =>
      expect(mocks.updateMine).toHaveBeenCalledWith({
        id: "t1",
        rating: "good",
      }),
    );
  });

  it("asks for a rating only on a solved or closed ticket", async () => {
    for (const status of ["open", "pending"]) {
      renderWidget({ detail: { ticket: ticket("t1", { status }) } });
      await openThread();
      expect(screen.queryByText("How did we do?"), status).toBeNull();
      expect(screen.queryByRole("button", { name: "Good" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Bad" })).toBeNull();
      cleanup();
    }
    for (const status of ["solved", "closed"]) {
      const { mocks } = renderWidget({
        detail: { ticket: ticket("t1", { status }) },
      });
      await openThread();
      expect(screen.getByText("How did we do?"), status).toBeTruthy();
      expect(screen.getByRole("button", { name: "Bad" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Good" }));
      await waitFor(() =>
        expect(mocks.updateMine).toHaveBeenCalledWith({
          id: "t1",
          rating: "good",
        }),
      );
      cleanup();
    }
  });

  it("shares with the organization, and unshares", async () => {
    const priv = renderWidget({
      detail: { ticket: ticket("t1", { organizationId: "org1" }) },
    });
    await openThread();
    const box = screen.getByLabelText(
      "Share with my organization",
    ) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    await waitFor(() =>
      expect(priv.mocks.updateMine).toHaveBeenCalledWith({
        id: "t1",
        visibility: "organization",
      }),
    );
    cleanup();

    const shared = renderWidget({
      detail: {
        ticket: ticket("t1", {
          organizationId: "org1",
          visibility: "organization",
        }),
      },
    });
    await openThread();
    const checked = screen.getByLabelText(
      "Share with my organization",
    ) as HTMLInputElement;
    expect(checked.checked).toBe(true);
    fireEvent.click(checked);
    await waitFor(() =>
      expect(shared.mocks.updateMine).toHaveBeenCalledWith({
        id: "t1",
        visibility: "private",
      }),
    );
  });

  it("hides solve, reopen, rate and share from a teammate, and shows them to the requester", async () => {
    for (const status of ["open", "solved"]) {
      const teammate = renderWidget({
        detail: {
          ticket: ticket("t1", {
            status,
            organizationId: "org1",
            visibility: "organization",
            isRequester: false,
          }),
        },
      });
      await openThread();
      expect(screen.getByLabelText("Reply")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Mark solved" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Reopen" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Good" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Bad" })).toBeNull();
      expect(screen.queryByLabelText("Share with my organization")).toBeNull();
      expect(teammate.mocks.updateMine).not.toHaveBeenCalled();
      cleanup();

      renderWidget({
        detail: {
          ticket: ticket("t1", {
            status,
            organizationId: "org1",
            visibility: "organization",
            isRequester: true,
          }),
        },
      });
      await openThread();
      expect(
        screen.getByRole("button", {
          name: status === "open" ? "Mark solved" : "Reopen",
        }),
      ).toBeTruthy();
      // the rating waits for a solved ticket
      if (status === "solved") {
        expect(screen.getByRole("button", { name: "Good" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Bad" })).toBeTruthy();
      } else {
        expect(screen.queryByRole("button", { name: "Good" })).toBeNull();
      }
      expect(screen.getByLabelText("Share with my organization")).toBeTruthy();
      cleanup();
    }
  });

  it("hides the share toggle on a ticket with no organization", async () => {
    renderWidget();
    await openThread();
    expect(screen.queryByLabelText("Share with my organization")).toBeNull();
  });

  it("marks an unread ticket seen once", async () => {
    const { mocks } = renderWidget({
      detail: { ticket: ticket("t1", { unread: true }) },
    });
    await openThread();
    await waitFor(() =>
      expect(mocks.markSeen).toHaveBeenCalledWith({ id: "t1" }),
    );
    expect(mocks.markSeen).toHaveBeenCalledTimes(1);
  });

  it("does not mark a read ticket seen", async () => {
    const { mocks } = renderWidget();
    await openThread();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.markSeen).not.toHaveBeenCalled();
  });

  it("goes back to the list", async () => {
    renderWidget();
    await openThread();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(
      await screen.findByRole("heading", { name: "My tickets" }),
    ).toBeTruthy();
  });

  it("lets renderMessage wrap or replace a message", async () => {
    renderWidget(
      { detail: { messages: [message("m1")] } },
      {
        renderMessage: (msg, fallback): ReactNode => (
          <div data-testid="custom">
            {msg.id}
            {fallback}
          </div>
        ),
      },
    );
    await openThread();
    const custom = screen.getByTestId("custom");
    expect(custom.textContent).toContain("m1");
    expect(within(custom).getByText("Body m1")).toBeTruthy();
  });

  it("routes same-origin links in a message through onNavigate", async () => {
    const onNavigate = vi.fn();
    const href = `${window.location.origin}/orders/9?x=1`;
    renderWidget(
      { detail: { messages: [message("m1", { body: `See ${href} please` })] } },
      { onNavigate },
    );
    await openThread();
    const link = screen.getByRole("link", { name: href });
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(fireEvent.click(link)).toBe(false);
    expect(onNavigate).toHaveBeenCalledWith("/orders/9?x=1");
  });

  it("leaves other-origin links to the browser", async () => {
    const onNavigate = vi.fn();
    renderWidget(
      {
        detail: {
          messages: [
            message("m1", { body: "See https://example.org/help please" }),
          ],
        },
      },
      { onNavigate },
    );
    await openThread();
    const link = screen.getByRole("link", { name: "https://example.org/help" });
    // record whether the widget claimed the click, then stop happy-dom from
    // following the link
    let claimed: boolean | undefined;
    const stop = (event: Event) => {
      claimed = event.defaultPrevented;
      event.preventDefault();
    };
    document.addEventListener("click", stop);
    fireEvent.click(link);
    document.removeEventListener("click", stop);
    expect(claimed).toBe(false);
    expect(onNavigate).not.toHaveBeenCalled();
  });
});

describe("SupportWidget attachments", () => {
  const withAttachment = {
    detail: {
      messages: [message("m1")],
      attachments: [attachment("a1")],
    },
  };

  it("hides the attachment UI when features.attachments is false", async () => {
    renderWidget({ ...withAttachment, attachments: false });
    await openThread();
    expect(screen.queryByText("Attach file")).toBeNull();
    expect(document.querySelector('input[type="file"]')).toBeNull();
    // already-stored files of a message are still shown for download
    expect(screen.getByText("report.pdf")).toBeTruthy();
  });

  it("shows the attachment UI when features.attachments is true", async () => {
    renderWidget({ ...withAttachment, attachments: true });
    await openThread();
    expect(screen.getByText("Attach file")).toBeTruthy();
    expect(document.querySelector('input[type="file"]')).not.toBeNull();
  });

  it("uploads, lists, removes and sends attachments with the reply", async () => {
    const { mocks } = renderWidget();
    await openThread();
    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const file = new File(["png"], "photo.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByText("Remove photo.png")).toBeTruthy();
    expect(mocks.$fetch).toHaveBeenCalledWith(
      "/support/upload",
      expect.objectContaining({
        method: "POST",
        query: { ticketId: "t1", filename: "photo.png" },
        body: file,
      }),
    );
    // customers never send `internal`
    expect(JSON.stringify(mocks.$fetch.mock.calls[0])).not.toContain(
      "internal",
    );

    fireEvent.change(screen.getByLabelText("Reply"), {
      target: { value: "See" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(mocks.reply).toHaveBeenCalledWith({
        ticketId: "t1",
        body: "See",
        attachmentIds: ["up1"],
      }),
    );
    await waitFor(() =>
      expect(screen.queryByText("Remove photo.png")).toBeNull(),
    );
  });

  it("drops an unsent upload", async () => {
    renderWidget();
    await openThread();
    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["x"], "photo.png", { type: "image/png" })] },
    });
    fireEvent.click(await screen.findByText("Remove photo.png"));
    expect(screen.queryByText("Remove photo.png")).toBeNull();
  });

  it("shows an error when an upload fails", async () => {
    const { mocks } = renderWidget();
    mocks.$fetch.mockImplementationOnce(() => failure() as never);
    await openThread();
    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["x"], "a.png", { type: "image/png" })] },
    });
    expect(
      await screen.findByText("The file could not be uploaded."),
    ).toBeTruthy();
  });

  it("uploads to the resolved ticket after a merge", async () => {
    const { mocks } = renderWidget({
      detail: {
        ticket: ticket("target", { number: 9, subject: "Merged target" }),
      },
    });
    await openPanel();
    fireEvent.click(await screen.findByRole("button", { name: /Subject t1/ }));
    await screen.findByRole("heading", { name: /Merged target/ });

    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["x"], "a.png", { type: "image/png" })] },
    });
    await waitFor(() =>
      expect(mocks.$fetch).toHaveBeenCalledWith(
        "/support/upload",
        expect.objectContaining({
          query: { ticketId: "target", filename: "a.png" },
        }),
      ),
    );
    fireEvent.change(screen.getByLabelText("Reply"), {
      target: { value: "Hi" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(mocks.reply).toHaveBeenCalledWith(
        expect.objectContaining({ ticketId: "target" }),
      ),
    );
  });

  it("downloads an attachment with its file name and never opens it in a tab", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const blob = new Blob(["pdf"], { type: "application/pdf" });
      const { mocks } = renderWidget(withAttachment);
      mocks.$fetch.mockImplementationOnce(() => ok(blob) as never);
      const open = vi.spyOn(window, "open").mockReturnValue(null);
      const clicked: HTMLAnchorElement[] = [];
      vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
        function (this: HTMLAnchorElement) {
          clicked.push(this);
        },
      );
      await openThread();
      // one action per file: save it
      expect(screen.queryByRole("button", { name: /^Open / })).toBeNull();
      fireEvent.click(
        screen.getByRole("button", { name: "Download report.pdf" }),
      );

      await waitFor(() => expect(clicked).toHaveLength(1));
      expect(mocks.$fetch).toHaveBeenCalledWith("/support/attachment", {
        method: "GET",
        query: { id: "a1" },
      });
      expect(URL.createObjectURL).toHaveBeenCalledWith(blob);
      expect(clicked[0]?.download).toBe("report.pdf");
      expect(clicked[0]?.getAttribute("href")).toBe("blob:fake");
      // the anchor is gone after the click, and the blob is never a page
      expect(clicked[0]?.isConnected).toBe(false);
      expect(open).not.toHaveBeenCalled();
      expect(URL.revokeObjectURL).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:fake");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows an error when an attachment cannot be opened", async () => {
    const { mocks } = renderWidget(withAttachment);
    mocks.$fetch.mockImplementationOnce(() => failure() as never);
    await openThread();
    fireEvent.click(
      screen.getByRole("button", { name: "Download report.pdf" }),
    );
    expect(
      await screen.findByText("The file could not be opened."),
    ).toBeTruthy();
  });
});

describe("SupportWidget ticketId (email deep links)", () => {
  it("starts open on that ticket's thread", async () => {
    const { mocks } = renderWidget(
      { detail: { ticket: ticket("t2") } },
      { ticketId: "t2" },
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    await screen.findByRole("heading", { name: /Subject t2/ });
    expect(mocks.ticket).toHaveBeenCalledWith({ query: { id: "t2" } });
  });

  it("goes back to the list from a linked ticket", async () => {
    const { mocks } = renderWidget(
      { detail: { ticket: ticket("t2") } },
      { ticketId: "t2" },
    );
    await screen.findByRole("heading", { name: /Subject t2/ });
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(
      await screen.findByRole("button", { name: /Subject t1/ }),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /Subject t2/ })).toBeNull();
    expect(mocks.myTickets).toHaveBeenCalled();
  });

  it("opens a new ticket when the prop changes, even after closing", async () => {
    const { client, mocks, rerender } = renderWidget(
      { detail: { ticket: ticket("t1") } },
      { ticketId: "t1" },
    );
    await screen.findByRole("heading", { name: /Subject t1/ });
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    expect(screen.queryByRole("dialog")).toBeNull();

    mocks.ticket.mockImplementation(() =>
      ok({ ticket: ticket("t2"), messages: [], attachments: [] }),
    );
    rerender(<SupportWidget client={client} pollInterval={0} ticketId="t2" />);
    expect(screen.getByRole("dialog")).toBeTruthy();
    await screen.findByRole("heading", { name: /Subject t2/ });
    expect(mocks.ticket).toHaveBeenCalledWith({ query: { id: "t2" } });
  });

  it("shows the thread's error state for a ticket it can't read", async () => {
    const { client, mocks } = makeClient();
    mocks.ticket.mockImplementation(
      () => failure({ status: 404, message: "Not found" }) as never,
    );
    render(
      <SupportWidget client={client} pollInterval={0} ticketId="missing" />,
    );
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("Something went wrong. Try again.")).toBeTruthy();
    expect(mocks.ticket).toHaveBeenCalledWith({ query: { id: "missing" } });
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(
      await screen.findByRole("button", { name: /Subject t1/ }),
    ).toBeTruthy();
  });

  it("starts closed on the list without ticketId", async () => {
    const { mocks } = renderWidget();
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(mocks.myTickets).toHaveBeenCalled());
    expect(mocks.ticket).not.toHaveBeenCalled();
  });
});

describe("SupportWidget popover and keyboard", () => {
  it("opens from the launcher and closes on Escape, returning focus", async () => {
    renderWidget();
    await openPanel();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");

    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("closes on Escape from inside a thread", async () => {
    renderWidget();
    await openThread();
    fireEvent.keyDown(screen.getByLabelText("Reply"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("closes on a click outside, not inside", async () => {
    renderWidget();
    await openPanel();
    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(screen.queryByRole("dialog")).not.toBeNull();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("reaches every control in DOM order, with no positive tabindex", async () => {
    renderWidget(
      {
        detail: {
          ticket: ticket("t1", { organizationId: "org1", status: "solved" }),
          attachments: [attachment("a1")],
        },
      },
      { organizationId: "org1" },
    );
    await openThread();
    const panel = screen.getByRole("dialog");
    const focusable = Array.from(
      panel.querySelectorAll<HTMLElement>(
        "button, input, textarea, select, a[href], [tabindex]",
      ),
    ).filter((el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled);

    expect(
      Array.from(panel.querySelectorAll("[tabindex]")).every(
        (el) => Number(el.getAttribute("tabindex")) <= 0,
      ),
    ).toBe(true);
    const names = focusable.map(
      (el) =>
        el.getAttribute("aria-label") ||
        (el.id && panel.querySelector(`label[for="${el.id}"]`)?.textContent) ||
        el.closest("label")?.textContent ||
        el.textContent,
    );
    expect(names).toEqual([
      "Back",
      "Download report.pdf",
      "Reopen",
      "Good",
      "Bad",
      "Share with my organization",
      "Reply",
      "Attach file",
    ]);
  });

  it("announces the unread count in a live region outside the launcher", async () => {
    renderWidget({
      tickets: [ticket("t1", { unread: true }), ticket("t2", { unread: true })],
    });
    await waitFor(() => {
      const region = document.querySelector('[aria-live="polite"]');
      expect(region?.textContent).toBe("2 unread tickets");
    });
    expect(
      trigger().contains(document.querySelector('[aria-live="polite"]')),
    ).toBe(false);
    expect(trigger().getAttribute("aria-describedby")).toBe(
      document.querySelector('[aria-live="polite"]')?.id,
    );
  });

  it("announces nothing with no unread tickets, and uses the label override", async () => {
    const quiet = renderWidget();
    await waitFor(() => expect(quiet.mocks.myTickets).toHaveBeenCalled());
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe(
      "",
    );
    cleanup();

    renderWidget(
      { tickets: [ticket("t1", { unread: true })] },
      { labels: { unreadCount: (n) => `${n} tickets need you` } },
    );
    await waitFor(() =>
      expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe(
        "1 tickets need you",
      ),
    );
  });
});

describe("SupportWidget labels", () => {
  it("renders overridden labels", async () => {
    renderWidget(
      { tickets: [ticket("t1", { status: "pending" })] },
      {
        labels: {
          support: "Hilfe",
          myTickets: "Meine Tickets",
          newTicket: "Neues Ticket",
          status: {
            open: "Offen",
            pending: "Wartend",
            solved: "Gelöst",
            closed: "Zu",
          },
          ticketNumber: (n) => `Nr. ${n}`,
          back: "Zurück",
          relativeTime: () => "vorhin",
        },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Hilfe" }));
    expect(
      await screen.findByRole("heading", { name: "Meine Tickets" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Neues Ticket" })).toBeTruthy();
    expect(screen.getByText("Wartend")).toBeTruthy();
    expect(screen.getByText("Nr. 1")).toBeTruthy();
    expect(screen.getByText("vorhin")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Subject t1/ }));
    expect(await screen.findByRole("button", { name: "Zurück" })).toBeTruthy();
  });

  it("keeps the other status labels when only one is overridden", async () => {
    renderWidget(
      { tickets: [ticket("t1", { status: "solved" })] },
      { labels: { status: { solved: "Done" } as never } },
    );
    await openPanel();
    expect(await screen.findByText("Done")).toBeTruthy();
  });

  it("takes every visible string from labels", async () => {
    const tagged = (key: string) => `«${key}»`;
    const labels: Record<string, unknown> = {};
    for (const [key, value] of Object.entries({
      ...defaultLabels,
      ...defaultWidgetLabels,
    })) {
      if (key === "status" || key === "priority" || key === "customerStatus") {
        labels[key] = Object.fromEntries(
          Object.keys(value as object).map((k) => [k, tagged(`${key}.${k}`)]),
        );
      } else if (typeof value === "function") {
        labels[key] = (...args: unknown[]) =>
          tagged(`${key}:${args.join(",")}`);
      } else {
        labels[key] = tagged(key);
      }
    }
    // fixture data the server (not labels) supplies
    const fixtureText = new Set([
      "Subject t1",
      "Subject t2",
      "Ada",
      "Body m1",
      "Body m2",
      "Body m4",
      "report.pdf",
      "photo.png",
      // Ada's avatar initials
      "A",
    ]);
    const texts = (root: Element): string[] => {
      const found: string[] = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        // what the user typed is not a label
        if (node.parentElement?.tagName === "TEXTAREA") continue;
        const text = (node.textContent ?? "").trim();
        if (/[A-Za-z]/.test(text)) found.push(text);
      }
      for (const el of root.querySelectorAll("*")) {
        for (const attr of ["aria-label", "placeholder", "title", "alt"]) {
          const value = el.getAttribute(attr);
          if (value && /[A-Za-z]/.test(value)) found.push(value);
        }
      }
      return found;
    };
    const expectTagged = (root: Element) => {
      const untagged = texts(root).filter(
        (text) => !text.includes("«") && !fixtureText.has(text),
      );
      expect(untagged).toEqual([]);
    };

    const { container, mocks } = renderWidget(
      {
        tickets: [
          ticket("t1", { unread: true, organizationId: "org1" }),
          ticket("t2"),
        ],
        nextCursor: "c",
        detail: {
          ticket: ticket("t1", {
            organizationId: "org1",
            status: "solved",
            unread: false,
          }),
          messages: [
            message("m1"),
            message("m2", {
              kind: "event",
              authorType: "system",
              author: null,
              data: { type: "status", from: "open", to: "solved" },
            }),
            message("m3", { kind: "event", data: { type: "merged" } }),
            message("m4", { authorType: "customer", author: null }),
          ],
          attachments: [attachment("a1")],
        },
      },
      { labels: labels as never, organizationId: "org1" },
    );
    await waitFor(() => expect(mocks.myTickets).toHaveBeenCalled());
    expectTagged(container);

    // list
    fireEvent.click(screen.getByRole("button", { name: "«support»" }));
    await screen.findByText("«myTickets»");
    expectTagged(container);

    // new ticket form
    fireEvent.click(screen.getByRole("button", { name: "«newTicket»" }));
    await screen.findByLabelText("«subject»");
    expectTagged(container);
    fireEvent.click(screen.getByRole("button", { name: "«back»" }));

    // thread with attachments, events, composer, upload state
    fireEvent.click(await screen.findByRole("button", { name: /Subject t1/ }));
    await screen.findByText("Body m1");
    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["x"], "photo.png", { type: "image/png" })] },
    });
    await screen.findByText(/«removeAttachment/);
    expectTagged(container);

    // failure states
    mocks.$fetch.mockImplementationOnce(() => failure() as never);
    fireEvent.click(
      screen.getByRole("button", { name: /«downloadAttachment/ }),
    );
    await screen.findByText("«attachmentFailed»");
    mocks.$fetch.mockImplementationOnce(() => failure() as never);
    fireEvent.change(input, {
      target: { files: [new File(["x"], "photo.png", { type: "image/png" })] },
    });
    await screen.findByText("«uploadFailed»");
    mocks.reply.mockImplementationOnce(() => failure() as never);
    fireEvent.change(screen.getByLabelText("«reply»"), {
      target: { value: "x" },
    });
    fireEvent.click(screen.getByRole("button", { name: "«send»" }));
    await screen.findByText("«somethingWrong»");
    expectTagged(container);
  });

  it("shows the closed notice from labels", async () => {
    renderWidget(
      { detail: { ticket: ticket("t1", { status: "closed" }) } },
      { labels: { ticketClosed: "Dicht." } },
    );
    await openThread();
    expect(screen.getByText("Dicht.")).toBeTruthy();
  });
});

describe("SupportWidget inline variant", () => {
  it("renders the panel in place, with no launcher and no dialog", async () => {
    renderWidget({}, { variant: "inline" });
    expect(screen.getByRole("region", { name: "Support" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Support" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      await screen.findByRole("button", { name: /Subject t1/ }),
    ).toBeTruthy();
    // the page keeps its focus on mount
    expect(document.activeElement).toBe(document.body);
  });

  it("does not close on Escape, a click outside or open={false}", async () => {
    renderWidget({}, { variant: "inline", open: false });
    await screen.findByRole("button", { name: /Subject t1/ });
    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.mouseDown(document.body);
    expect(screen.getByRole("region", { name: "Support" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Subject t1/ })).toBeTruthy();
  });

  it("opens ticketId's thread in place, Back goes to the list, a new id opens it", async () => {
    const { client, mocks, rerender } = renderWidget(
      { detail: { ticket: ticket("t2") } },
      { variant: "inline", ticketId: "t2" },
    );
    await screen.findByRole("heading", { name: /Subject t2/ });
    expect(document.activeElement).toBe(document.body);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(
      await screen.findByRole("button", { name: /Subject t1/ }),
    ).toBeTruthy();
    // moving between views inside the widget takes focus
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "My tickets" }),
    );

    mocks.ticket.mockImplementation(() =>
      ok({ ticket: ticket("t1"), messages: [], attachments: [] }),
    );
    rerender(
      <SupportWidget
        client={client}
        pollInterval={0}
        variant="inline"
        ticketId="t1"
      />,
    );
    await screen.findByRole("heading", { name: /Subject t1/ });
  });
});

describe("SupportWidget onTicketChange", () => {
  async function createFromForm() {
    fireEvent.click(await screen.findByRole("button", { name: "New ticket" }));
    fireEvent.change(await screen.findByLabelText("Subject"), {
      target: { value: "Printer" },
    });
    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "It is on fire" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit ticket" }));
  }

  it("inline: reports opening a row, creating a ticket and Back, not the initial ticketId", async () => {
    const onTicketChange = vi.fn();
    renderWidget(
      { detail: { ticket: ticket("t2") } },
      { variant: "inline", ticketId: "t2", onTicketChange },
    );
    await screen.findByRole("heading", { name: /Subject t2/ });
    expect(onTicketChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByRole("heading", { name: "My tickets" });
    expect(onTicketChange).toHaveBeenLastCalledWith(null);

    fireEvent.click(screen.getByRole("button", { name: /Subject t1/ }));
    expect(onTicketChange).toHaveBeenLastCalledWith("t1");
    fireEvent.click(await screen.findByRole("button", { name: "Back" }));
    expect(onTicketChange).toHaveBeenLastCalledWith(null);
    expect(onTicketChange).toHaveBeenCalledTimes(3);

    // the new-ticket form has no open ticket either: list -> form -> list is no change
    fireEvent.click(await screen.findByRole("button", { name: "New ticket" }));
    fireEvent.click(await screen.findByRole("button", { name: "Back" }));
    await screen.findByRole("heading", { name: "My tickets" });
    expect(onTicketChange).toHaveBeenCalledTimes(3);

    await createFromForm();
    await waitFor(() => expect(onTicketChange).toHaveBeenLastCalledWith("new"));
    expect(onTicketChange).toHaveBeenCalledTimes(4);
  });

  it("a move that lands before the re-render after a ticketId change compares with the new ticket", async () => {
    // React runs a later sibling's effects in the same flush as the widget's
    // ticketId effect, before the re-render that effect schedules. A click
    // on the list row there must already see the thread the prop opened:
    // opening it again is no change and reports nothing
    const onTicketChange = vi.fn();
    const { client } = makeClient({ detail: { ticket: ticket("t2") } });
    function OpenOnChange({ id }: { id: string | null }) {
      useEffect(() => {
        if (id !== "t2") return;
        screen.getByRole("button", { name: /Subject t2/ }).click();
      }, [id]);
      return null;
    }
    const ui = (id: string | null) => (
      <>
        <SupportWidget
          client={client}
          variant="inline"
          pollInterval={0}
          ticketId={id}
          onTicketChange={onTicketChange}
        />
        <OpenOnChange id={id} />
      </>
    );
    const { rerender } = render(ui(null));
    await screen.findByRole("button", { name: /Subject t2/ });
    rerender(ui("t2"));
    await screen.findByRole("heading", { name: /Subject t2/ });
    expect(onTicketChange).not.toHaveBeenCalled();
  });

  it("does not report a ticket created after the widget unmounted", async () => {
    const onTicketChange = vi.fn();
    type Created = Awaited<
      ReturnType<typeof ok<{ ticket: ReturnType<typeof ticket> }>>
    >;
    let settle: (value: Created) => void = () => {};
    const { mocks, unmount } = renderWidget(
      {},
      { variant: "inline", onTicketChange },
    );
    mocks.createTicket.mockImplementation(
      () =>
        new Promise<Created>((resolve) => {
          settle = resolve;
        }),
    );
    await createFromForm();
    await waitFor(() => expect(mocks.createTicket).toHaveBeenCalled());
    unmount();
    await act(async () => {
      settle({ data: { ticket: ticket("late") }, error: null });
    });
    expect(onTicketChange).not.toHaveBeenCalled();
  });

  it("stays on the list when the user went Back before the create settled", async () => {
    const onTicketChange = vi.fn();
    type Created = Awaited<
      ReturnType<typeof ok<{ ticket: ReturnType<typeof ticket> }>>
    >;
    let settle: (value: Created) => void = () => {};
    const { mocks } = renderWidget({}, { variant: "inline", onTicketChange });
    mocks.createTicket.mockImplementation(
      () =>
        new Promise<Created>((resolve) => {
          settle = resolve;
        }),
    );
    await createFromForm();
    await waitFor(() => expect(mocks.createTicket).toHaveBeenCalled());
    // Back stays usable while the ticket is being created
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByRole("heading", { name: "My tickets" });
    const listLoads = mocks.myTickets.mock.calls.length;
    await act(async () => {
      settle({ data: { ticket: ticket("late") }, error: null });
    });
    await act(async () => {});
    expect(screen.getByRole("heading", { name: "My tickets" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /Subject late/ })).toBeNull();
    expect(mocks.ticket).not.toHaveBeenCalled();
    expect(onTicketChange).not.toHaveBeenCalled();
    // the list loads again, so the new ticket shows up there
    expect(mocks.myTickets.mock.calls.length).toBeGreaterThan(listLoads);
  });

  it("a create that settles after Back and New again doesn't open it from the second form", async () => {
    const onTicketChange = vi.fn();
    type Created = Awaited<
      ReturnType<typeof ok<{ ticket: ReturnType<typeof ticket> }>>
    >;
    let settle: (value: Created) => void = () => {};
    const { mocks } = renderWidget({}, { variant: "inline", onTicketChange });
    mocks.createTicket.mockImplementation(
      () =>
        new Promise<Created>((resolve) => {
          settle = resolve;
        }),
    );
    await createFromForm();
    await waitFor(() => expect(mocks.createTicket).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(await screen.findByRole("button", { name: "New ticket" }));
    await screen.findByLabelText("Subject");
    await act(async () => {
      settle({ data: { ticket: ticket("late") }, error: null });
    });
    await act(async () => {});
    expect(screen.getByLabelText("Subject")).toBeTruthy();
    expect(mocks.ticket).not.toHaveBeenCalled();
    expect(onTicketChange).not.toHaveBeenCalled();
  });

  it("inline: never reports changes from the ticketId prop, and null goes back to the list", async () => {
    const onTicketChange = vi.fn();
    const { client, mocks, rerender } = renderWidget(
      { detail: { ticket: ticket("t1") } },
      { variant: "inline", onTicketChange },
    );
    await screen.findByRole("heading", { name: "My tickets" });
    const props = {
      client,
      pollInterval: 0,
      badgePollInterval: 0,
      variant: "inline" as const,
      onTicketChange,
    };

    rerender(<SupportWidget {...props} ticketId="t1" />);
    await screen.findByRole("heading", { name: /Subject t1/ });
    mocks.ticket.mockImplementation(() =>
      ok({ ticket: ticket("t2"), messages: [], attachments: [] }),
    );
    rerender(<SupportWidget {...props} ticketId="t2" />);
    await screen.findByRole("heading", { name: /Subject t2/ });
    // the browser's back button: the link goes away, the widget follows
    rerender(<SupportWidget {...props} ticketId={null} />);
    await screen.findByRole("heading", { name: "My tickets" });
    expect(onTicketChange).not.toHaveBeenCalled();

    // the user's next move is compared with what the prop put on screen
    rerender(<SupportWidget {...props} ticketId="t2" />);
    await screen.findByRole("heading", { name: /Subject t2/ });
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onTicketChange).toHaveBeenCalledTimes(1);
    expect(onTicketChange).toHaveBeenLastCalledWith(null);
  });

  it("inline: keeps a page's URL in step both ways", async () => {
    const { client } = makeClient({ detail: { ticket: ticket("t2") } });
    const urls: Array<string | null> = [];
    function Page() {
      const [ticketId, setTicketId] = useState<string | null>("t2");
      return (
        <SupportWidget
          client={client}
          pollInterval={0}
          variant="inline"
          ticketId={ticketId}
          onTicketChange={(next) => {
            urls.push(next);
            setTicketId(next);
          }}
        />
      );
    }
    render(<Page />);
    await screen.findByRole("heading", { name: /Subject t2/ });
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByRole("heading", { name: "My tickets" });
    fireEvent.click(screen.getByRole("button", { name: /Subject t1/ }));
    await screen.findByRole("button", { name: "Back" });
    expect(urls).toEqual([null, "t1"]);
  });

  it("popover: reports the user's moves, not opening, closing or the initial ticketId", async () => {
    const onTicketChange = vi.fn();
    const { client, rerender } = renderWidget(
      { detail: { ticket: ticket("t2") } },
      { ticketId: "t2", onTicketChange },
    );
    await screen.findByRole("heading", { name: /Subject t2/ });
    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.click(trigger());
    await screen.findByRole("heading", { name: /Subject t2/ });
    expect(onTicketChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onTicketChange).toHaveBeenLastCalledWith(null);
    fireEvent.click(await screen.findByRole("button", { name: /Subject t1/ }));
    expect(onTicketChange).toHaveBeenLastCalledWith("t1");
    expect(onTicketChange).toHaveBeenCalledTimes(2);

    // a new ticketId from the app opens that ticket without echoing it
    rerender(
      <SupportWidget
        client={client}
        pollInterval={0}
        badgePollInterval={0}
        ticketId="t1"
        onTicketChange={onTicketChange}
      />,
    );
    await screen.findByRole("button", { name: "Back" });
    expect(onTicketChange).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await createFromForm();
    await waitFor(() => expect(onTicketChange).toHaveBeenLastCalledWith("new"));
    expect(onTicketChange.mock.calls).toEqual([
      [null],
      ["t1"],
      [null],
      ["new"],
    ]);
  });
});

describe("SupportWidget open state", () => {
  it("defaultOpen opens the panel on the list", async () => {
    renderWidget({}, { defaultOpen: true });
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(
      await screen.findByRole("button", { name: /Subject t1/ }),
    ).toBeTruthy();
  });

  it("defaultOpen={false} with ticketId starts closed, then opens on that ticket", async () => {
    renderWidget(
      { detail: { ticket: ticket("t2") } },
      { ticketId: "t2", defaultOpen: false },
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(trigger());
    await screen.findByRole("heading", { name: /Subject t2/ });
  });

  it("is controlled by open, and asks onOpenChange to change it", async () => {
    const onOpenChange = vi.fn();
    const { client, rerender } = renderWidget({}, { open: true, onOpenChange });
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.click(trigger());
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole("dialog")).toBeTruthy(); // the app decides
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    fireEvent.mouseDown(document.body);
    expect(onOpenChange).toHaveBeenCalledTimes(3);

    const props = { client, pollInterval: 0, badgePollInterval: 0 };
    rerender(
      <SupportWidget {...props} open={false} onOpenChange={onOpenChange} />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(trigger());
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the same ticketId again when the app reopens the panel", async () => {
    const { client } = makeClient({ detail: { ticket: ticket("t2") } });
    function Page() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Email link
          </button>
          <SupportWidget
            client={client}
            pollInterval={0}
            badgePollInterval={0}
            ticketId="t2"
            open={open}
            onOpenChange={setOpen}
          />
        </>
      );
    }
    render(<Page />);
    await screen.findByRole("heading", { name: /Subject t2/ });
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByRole("button", { name: /Subject t1/ });
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    // the launcher reopens where the user left off
    fireEvent.click(trigger());
    await screen.findByRole("button", { name: /Subject t1/ });
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    // the app opening it again shows the linked ticket
    fireEvent.click(screen.getByRole("button", { name: "Email link" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    await screen.findByRole("heading", { name: /Subject t2/ });
  });
  it("opens the linked ticket when the app opens the panel after declining a launcher click", async () => {
    const { client } = makeClient({ detail: { ticket: ticket("t2") } });
    let decline = false;
    function Page() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Email link
          </button>
          <SupportWidget
            client={client}
            pollInterval={0}
            badgePollInterval={0}
            ticketId="t2"
            open={open}
            onOpenChange={(next) => {
              if (next && decline) return; // the app says no
              setOpen(next);
            }}
          />
        </>
      );
    }
    render(<Page />);
    await screen.findByRole("heading", { name: /Subject t2/ });
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByRole("button", { name: /Subject t1/ });
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    // the launcher asks; the app keeps open={false}
    decline = true;
    fireEvent.click(trigger());
    await act(async () => {});
    expect(screen.queryByRole("dialog")).toBeNull();

    // later the app opens it itself: that shows the linked ticket
    fireEvent.click(screen.getByRole("button", { name: "Email link" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    await screen.findByRole("heading", { name: /Subject t2/ });
  });
});

describe("SupportWidget polling", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls at badgePollInterval (60 s) while closed and pollInterval (15 s) while open", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { mocks } = renderWidget(
      {},
      { pollInterval: undefined, badgePollInterval: undefined },
    );
    await waitFor(() => expect(mocks.myTickets).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mocks.myTickets).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(mocks.myTickets).toHaveBeenCalledTimes(2);

    fireEvent.click(trigger());
    await screen.findByRole("dialog");
    // opening refreshes once, then polls at pollInterval
    await waitFor(() => expect(mocks.myTickets).toHaveBeenCalledTimes(3));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mocks.myTickets).toHaveBeenCalledTimes(4);

    fireEvent.keyDown(document.body, { key: "Escape" });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mocks.myTickets).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(mocks.myTickets).toHaveBeenCalledTimes(5);
  });

  it("takes custom intervals, and pauses the badge poll while the tab is hidden", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { mocks } = renderWidget(
      {},
      { pollInterval: 1000, badgePollInterval: 5000 },
    );
    await waitFor(() => expect(mocks.myTickets).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.myTickets).toHaveBeenCalledTimes(2);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    try {
      await vi.advanceTimersByTimeAsync(20_000);
      expect(mocks.myTickets).toHaveBeenCalledTimes(2);
    } finally {
      delete (document as { visibilityState?: unknown }).visibilityState;
    }
    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.myTickets).toHaveBeenCalledTimes(3);
  });

  it("polls at pollInterval inline", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { mocks } = renderWidget(
      {},
      { variant: "inline", pollInterval: undefined, badgePollInterval: 5000 },
    );
    await waitFor(() => expect(mocks.myTickets).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mocks.myTickets).toHaveBeenCalledTimes(2);
  });
});

/** A text input or textarea: what `fieldClassName` styles. */
function isField(el: Element): boolean {
  if (el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)
    return true;
  return (
    el instanceof HTMLInputElement &&
    !["checkbox", "radio", "file", "hidden"].includes(el.type)
  );
}

function describeControl(el: Element): string {
  const name =
    el.getAttribute("aria-label") ??
    el.getAttribute("placeholder") ??
    el.textContent?.trim().slice(0, 30);
  return `${el.tagName.toLowerCase()}[${el.getAttribute("type") ?? ""}] ${name}`;
}

/**
 * Why a control's hit area is under 44px on a coarse pointer, or null. A
 * checkbox or the (visually hidden) file input counts through its label.
 */
function touchProblem(el: HTMLElement): string | null {
  const viaLabel =
    el instanceof HTMLInputElement &&
    (el.type === "checkbox" || el.type === "radio" || el.type === "file");
  const target = viaLabel ? el.closest("label") : el;
  if (!target) return "no label";
  if (!target.className.split(/\s+/).includes("pointer-coarse:min-h-11"))
    return "height";
  return null;
}

/** A solved, shared ticket with an attachment, and more tickets to load. */
function widgetEverything(): Setup {
  const shared = ticket("t1", {
    organizationId: "org1",
    visibility: "organization",
    status: "solved",
  });
  return {
    tickets: [shared, ticket("t2")],
    nextCursor: "c",
    detail: {
      ticket: shared,
      messages: [message("m1")],
      attachments: [attachment("a1")],
    },
  };
}

/**
 * Walks the popover through the list, the new-ticket form and a thread with
 * an upload, calling `scan` at each step. Returns a counter of the fields
 * seen across the steps.
 */
async function openEveryWidgetPart(scan: () => void) {
  let fields = 0;
  const step = () => {
    fields += Array.from(
      document.querySelectorAll("input, select, textarea"),
    ).filter(isField).length;
    scan();
  };
  step();
  await openPanel();
  await screen.findByText(/Subject t1/);
  step();
  fireEvent.click(screen.getByRole("button", { name: "New ticket" }));
  await screen.findByLabelText("Subject");
  step();
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  fireEvent.click(await screen.findByRole("button", { name: /Subject t1/ }));
  await screen.findByText("Body m1");
  const file = document.querySelector<HTMLInputElement>("input[type=file]");
  if (!file) throw new Error("no file input");
  fireEvent.change(file, {
    target: { files: [new File(["a"], "photo.png", { type: "image/png" })] },
  });
  await screen.findByText("Remove photo.png");
  step();
  return () => fields;
}

describe("SupportWidget classes and layout", () => {
  it("applies className and the per-part class props", async () => {
    const { container } = renderWidget(
      {
        detail: {
          messages: [message("m1")],
          attachments: [],
        },
      },
      {
        className: "root-x",
        listClassName: "list-x",
        threadClassName: "thread-x",
        messageClassName: "message-x",
        composerClassName: "composer-x",
        buttonClassName: "button-x",
        fieldClassName: "field-x",
      },
    );
    expect(container.firstElementChild?.className).toContain("root-x");
    // class props append: the launcher keeps its own look
    expect(trigger().className).toContain("button-x");
    expect(trigger().className).toContain("bg-background");
    expect(trigger().className).toContain("rounded-md");

    await openPanel();
    expect(document.querySelector(".list-x")?.className).toContain("flex");
    fireEvent.click(await screen.findByRole("button", { name: "New ticket" }));
    expect(document.querySelector(".composer-x")).not.toBeNull();
    expect(screen.getByLabelText("Subject").className).toContain("field-x");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    fireEvent.click(await screen.findByRole("button", { name: /Subject t1/ }));
    await screen.findByText("Body m1");
    expect(document.querySelector(".thread-x")?.className).toContain("flex");
    // on each message row, around the bubble
    expect(document.querySelector(".message-x")?.textContent).toContain(
      "Body m1",
    );
    expect(document.querySelector(".composer-x")).not.toBeNull();
  });

  it("fieldClassName reaches every text input and textarea, and nothing else", async () => {
    const { container } = renderWidget(widgetEverything(), {
      organizationId: "org1",
      fieldClassName: "field-x",
    });
    const missing = new Set<string>();
    const stray = new Set<string>();
    // 16px text below md, so iOS doesn't zoom into a focused field
    const zooms = new Set<string>();
    const scan = () => {
      for (const el of container.querySelectorAll<HTMLElement>("*")) {
        const has = el.classList.contains("field-x");
        if (isField(el) && !has) missing.add(describeControl(el));
        if (!isField(el) && has) stray.add(describeControl(el));
        if (
          isField(el) &&
          !(
            el.classList.contains("text-base") &&
            el.classList.contains("md:text-sm")
          )
        )
          zooms.add(describeControl(el));
      }
    };
    const fields = await openEveryWidgetPart(scan);
    expect([...missing]).toEqual([]);
    expect([...stray]).toEqual([]);
    expect([...zooms]).toEqual([]);
    expect(fields()).toBeGreaterThanOrEqual(3);
  });

  it("gives every control a 44px target on a coarse pointer", async () => {
    const { container } = renderWidget(widgetEverything(), {
      organizationId: "org1",
    });
    const small = new Set<string>();
    let seen = 0;
    const scan = () => {
      for (const el of container.querySelectorAll<HTMLElement>(
        "button, input, select, textarea",
      )) {
        seen += 1;
        const problem = touchProblem(el);
        if (problem) small.add(`${describeControl(el)}: ${problem}`);
      }
    };
    await openEveryWidgetPart(scan);
    expect([...small]).toEqual([]);
    // the scan reached the rating, the share toggle and both attachment buttons
    for (const name of [
      "Good",
      "Share with my organization",
      "Remove photo.png",
    ]) {
      expect(screen.getAllByText(name).length).toBeGreaterThan(0);
    }
    expect(
      screen.getAllByRole("button", { name: "Download report.pdf" }).length,
    ).toBeGreaterThan(0);
    expect(seen).toBeGreaterThan(10);
  });

  it("appends className to the inline panel's own classes", () => {
    renderWidget({}, { variant: "inline", className: "root-x" });
    const panel = screen.getByRole("region", { name: "Support" });
    expect(panel.className).toContain("root-x");
    expect(panel.className).toContain("w-full");
    expect(panel.className).toContain("border-border");
  });

  it("uses no fixed width above 360px", async () => {
    const { container } = renderWidget(
      {
        tickets: [ticket("t1", { organizationId: "org1" })],
        nextCursor: "c",
        detail: {
          ticket: ticket("t1", { organizationId: "org1" }),
          attachments: [attachment("a1")],
        },
      },
      { organizationId: "org1" },
    );
    const sizes: Record<string, number> = {
      xs: 320,
      sm: 384,
      md: 448,
      lg: 512,
      xl: 576,
      "2xl": 672,
      "3xl": 768,
      "4xl": 896,
      "5xl": 1024,
      "6xl": 1152,
      "7xl": 1280,
    };
    const toPx = (raw: string): number | null => {
      const arbitrary = /^\[(-?[\d.]+)(px|rem|em)?\]$/.exec(raw);
      if (arbitrary) {
        const n = Number(arbitrary[1]);
        return arbitrary[2] === "rem" || arbitrary[2] === "em" ? n * 16 : n;
      }
      if (raw.startsWith("[")) return null; // calc(), vw, etc.: viewport relative
      if (raw in sizes) return sizes[raw] as number;
      if (/^[\d.]+$/.test(raw)) return Number(raw) * 4; // spacing scale
      return null; // full, screen, fit, min, max, auto, fractions
    };
    const tooWide: string[] = [];
    const scan = () => {
      for (const el of container.querySelectorAll("[class]")) {
        for (const token of el.getAttribute("class")?.split(/\s+/) ?? []) {
          const utility = token.split(":").pop() ?? "";
          const match = /^(?:min-w|max-w|w|size)-(.+)$/.exec(utility);
          if (!match) continue;
          const px = toPx(match[1] as string);
          if (px !== null && px > 360) tooWide.push(token);
        }
      }
    };

    await openPanel();
    await screen.findByText(/Subject t1/);
    scan();
    fireEvent.click(screen.getByRole("button", { name: "New ticket" }));
    await screen.findByLabelText("Subject");
    scan();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(await screen.findByRole("button", { name: /Subject t1/ }));
    await screen.findByText("Body m1");
    scan();

    expect(tooWide).toEqual([]);
    // the panel is capped at 360px and never wider than the viewport
    const panel = screen.getByRole("dialog");
    expect(panel.className).toContain("max-w-[22.5rem]");
    expect(panel.className).toContain("w-[calc(100vw-2rem)]");
  });
});
