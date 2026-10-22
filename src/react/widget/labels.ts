// Shared keys live in ../labels.ts; the widget takes Partial<SupportLabels & SupportWidgetLabels>.

/** Strings only `SupportWidget` shows. Override any with `labels`. */
export type SupportWidgetLabels = {
  /** Heading of the customer's ticket list. */
  myTickets: string;
  /** Shown while the list or a thread loads. */
  loading: string;
  /** Shown (as an alert) when a load or an action fails. */
  somethingWrong: string;
  /** Screen-reader text on a ticket row with a reply the customer has not seen. */
  unreadTicket: string;
  /** Submit button of the new-ticket form. */
  createTicket: string;
  /** Placeholder of the message box of the new-ticket form. */
  messagePlaceholder: string;
  /** Placeholder of the reply box. */
  replyPlaceholder: string;
  /** Shown instead of the reply box on a closed ticket. */
  ticketClosed: string;
  /** Shown above the good/bad buttons. */
  ratePrompt: string;
  /** Name of a sender who has no name (`authorType` agent). */
  supportTeam: string;
  /** Name of a sender who has no name (`authorType` customer). */
  unknownAuthor: string;
  /** A status change row in the thread; both arguments are `labels.status` strings. */
  statusChanged: (from: string, to: string) => string;
  /** The row shown in a ticket that was merged into this one. */
  ticketMerged: string;
  /**
   * @deprecated Unused: the widget only downloads attachments (a file is
   * never opened in a tab). Kept so existing overrides still type-check.
   */
  openAttachment: (filename: string) => string;
  /** Label of the button that saves an attachment. */
  downloadAttachment: (filename: string) => string;
  /** Label of the button that drops an unsent upload. */
  removeAttachment: (filename: string) => string;
  /** Shown while a file uploads. */
  uploading: string;
  /** Shown when an upload fails. */
  uploadFailed: string;
  /** Shown when an attachment can't be downloaded. */
  attachmentFailed: string;
  /** Heading of the attachments of a message. */
  attachments: string;
  /** A file size, e.g. "12 KB". */
  fileSize: (bytes: number) => string;
  /**
   * Ticket statuses in the customer's words, shown in the list, the thread
   * header and status changes ("Awaiting your reply" rather than "Pending").
   * A status overridden in `status` and not here shows the `status` text.
   */
  customerStatus: Record<"open" | "pending" | "solved" | "closed", string>;
  /** Shown in an empty list, above the New ticket button. */
  emptyHint: string;
  /** Alt text of an image attachment preview. */
  imagePreview: (filename: string) => string;
  /** Heading over the kinds of support (the server's `categories`). */
  chooseCategory: string;
  /**
   * Each category's card and form wording, by category id. A category the
   * server offers that is missing here shows its id as the title.
   */
  categories: Record<string, SupportCategoryLabels>;
};

/** How the widget presents one kind of support. */
export type SupportCategoryLabels = {
  /** The card's title and the form's heading: "Report a bug". */
  title: string;
  /** Under the title on the card: "Something isn't working". */
  hint: string;
  /** Placeholder of the form's message box. */
  placeholder: string;
};

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const defaultWidgetLabels: SupportWidgetLabels = {
  myTickets: "My tickets",
  loading: "Loading…",
  somethingWrong: "Something went wrong. Try again.",
  unreadTicket: "Unread",
  createTicket: "Submit ticket",
  messagePlaceholder: "How can we help?",
  replyPlaceholder: "Write a reply…",
  ticketClosed: "This ticket is closed.",
  ratePrompt: "How did we do?",
  supportTeam: "Support",
  unknownAuthor: "Someone",
  statusChanged: (from, to) => `Status changed from ${from} to ${to}`,
  ticketMerged: "A duplicate ticket was merged into this one",
  openAttachment: (filename) => `Open ${filename}`,
  downloadAttachment: (filename) => `Download ${filename}`,
  removeAttachment: (filename) => `Remove ${filename}`,
  uploading: "Uploading…",
  uploadFailed: "The file could not be uploaded.",
  attachmentFailed: "The file could not be opened.",
  attachments: "Attachments",
  fileSize: formatFileSize,
  customerStatus: {
    open: "With our team",
    pending: "Awaiting your reply",
    solved: "Solved",
    closed: "Closed",
  },
  emptyHint: "Questions, problems or ideas: we read every ticket.",
  imagePreview: (filename) => `Preview of ${filename}`,
  chooseCategory: "What can we help with?",
  categories: {
    question: {
      title: "Ask a question",
      hint: "How do I…?",
      placeholder: "What are you trying to do?",
    },
    bug: {
      title: "Report a bug",
      hint: "Something isn't working",
      placeholder: "What happened, and what did you expect to happen?",
    },
    feature: {
      title: "Suggest a feature",
      hint: "What would make your work easier?",
      placeholder: "What would you like to do, and why?",
    },
    sales: {
      title: "Talk to us",
      hint: "Plans, billing or anything else",
      placeholder: "How can we help?",
    },
  },
};
