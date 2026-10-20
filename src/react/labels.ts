// BYO_STUB: final owner N12a. The seeded keys are final; N12a may add keys (never rename or remove).
// Shared by both components. Keys only the widget or only the inbox uses go in
// widget/labels.ts (N12b) or inbox/labels.ts (N12c).

/** Every user-facing string in `SupportWidget` and `SupportInbox`. Override any with `labels`. */
export type SupportLabels = {
  support: string;
  newTicket: string;
  subject: string;
  message: string;
  send: string;
  reply: string;
  internalNote: string;
  attach: string;
  solve: string;
  reopen: string;
  rateGood: string;
  rateBad: string;
  shareWithOrganization: string;
  back: string;
  loadMore: string;
  empty: string;
  close: string;
  status: Record<"open" | "pending" | "solved" | "closed", string>;
  priority: Record<"low" | "normal" | "high" | "urgent", string>;
  /** Announced to screen readers when the unread count changes. */
  unreadCount: (count: number) => string;
  /** `#123` */
  ticketNumber: (number: number) => string;
  /** A message or ticket time. Components show times only through this. @default formatRelativeTime */
  relativeTime: (value: Date | string) => string;
};

export const defaultLabels: SupportLabels = {
  support: "Support",
  newTicket: "New ticket",
  subject: "Subject",
  message: "Message",
  send: "Send",
  reply: "Reply",
  internalNote: "Internal note",
  attach: "Attach file",
  solve: "Mark solved",
  reopen: "Reopen",
  rateGood: "Good",
  rateBad: "Bad",
  shareWithOrganization: "Share with my organization",
  back: "Back",
  loadMore: "Load more",
  empty: "No tickets yet",
  close: "Close",
  status: {
    open: "Open",
    pending: "Pending",
    solved: "Solved",
    closed: "Closed",
  },
  priority: { low: "Low", normal: "Normal", high: "High", urgent: "Urgent" },
  unreadCount: (count) =>
    count === 1 ? "1 unread ticket" : `${count} unread tickets`,
  ticketNumber: (number) => `#${number}`,
  relativeTime: (value) => formatRelativeTime(value),
};

/**
 * A short relative time ("just now", "5m ago", "3h ago", "2d ago", then the
 * locale date). Shared non-visual helper for both components.
 */
export function formatRelativeTime(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return date.toLocaleString();
}
