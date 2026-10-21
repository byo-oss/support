// Shared keys live in ../labels.ts (N12a); the inbox takes Partial<SupportLabels & SupportInboxLabels>.
// Keys here are only used by `SupportInbox`. Add keys, never rename or remove one.

/** Strings only `SupportInbox` shows. */
export type SupportInboxLabels = {
  /** Heading and region name of the staff queue. */
  queue: string;
  /** Label and placeholder of the queue search box (ticket number or subject). */
  search: string;
  filterStatus: string;
  allStatuses: string;
  filterAssignee: string;
  allAssignees: string;
  assignedToMe: string;
  unassigned: string;
  filterTag: string;
  allTags: string;
  /** Queue count chips. */
  countOpen: (count: number) => string;
  countPending: (count: number) => string;
  countUnassigned: (count: number) => string;
  countMine: (count: number) => string;
  /** Announced (live region) when the queue counts change. */
  queueSummary: (counts: {
    open: number;
    pending: number;
    unassigned: number;
    mine: number;
  }) => string;
  loading: string;
  loadError: string;
  /** Checkbox label of one queue row. */
  selectTicket: (number: number) => string;
  selectAll: string;
  selectedCount: (count: number) => string;
  clearSelection: string;
  /** Placeholder options of the bulk selects. */
  bulkStatus: string;
  bulkPriority: string;
  bulkAssignee: string;
  /** Bulk and side-panel tag controls. */
  tags: string;
  addTag: string;
  removeTag: string;
  removeTagNamed: (tag: string) => string;
  tagPlaceholder: string;
  noTags: string;
  noPriority: string;
  delete: string;
  deleteTicket: string;
  /** The inline confirmation after Delete. */
  confirmDelete: (count: number) => string;
  confirmDeleteAction: string;
  cancel: string;
  /** Shown instead of the thread when nothing is selected (wide layout). */
  selectPrompt: string;
  /** Toggle of the details panel (narrow layout). */
  details: string;
  assignee: string;
  priorityField: string;
  statusField: string;
  /** Messages and timeline. */
  system: string;
  unknownSender: string;
  unknownAgent: string;
  noteBadge: string;
  internalBadge: string;
  unverifiedBadge: string;
  eventStatus: (from: string, to: string) => string;
  eventAssigned: (name: string) => string;
  eventUnassigned: string;
  eventPriority: (priority: string) => string;
  eventPriorityCleared: string;
  eventMerged: string;
  eventAttachmentDropped: string;
  eventFollowup: string;
  /** `Open attachment report.pdf` (the accessible name of an attachment button). */
  openAttachment: (filename: string) => string;
  /** `12 KB` */
  fileSize: (bytes: number) => string;
  /** Composer. */
  composerLabel: string;
  modeLabel: string;
  statusOnSend: string;
  statusOnSendDefault: string;
  removeAttachment: (filename: string) => string;
  uploading: string;
  uploadFailed: string;
  sendFailed: string;
  sending: string;
  /** Canned replies. */
  cannedReplies: string;
  cannedSearch: string;
  cannedEmpty: string;
  cannedManage: string;
  cannedTitle: string;
  cannedBody: string;
  cannedSave: string;
  cannedDelete: (title: string) => string;
  /** @mentions. */
  mention: string;
  mentionAgent: (name: string) => string;
  /** Merge. */
  merge: string;
  mergeSearch: string;
  mergeEmpty: string;
  mergeInto: (number: number) => string;
  confirmMerge: (source: number, target: number) => string;
  confirmMergeAction: string;
};

export const defaultInboxLabels: SupportInboxLabels = {
  queue: "Support queue",
  search: "Search by number or subject",
  filterStatus: "Filter by status",
  allStatuses: "All statuses",
  filterAssignee: "Filter by assignee",
  allAssignees: "Everyone",
  assignedToMe: "Assigned to me",
  unassigned: "Unassigned",
  filterTag: "Filter by tag",
  allTags: "All tags",
  countOpen: (count) => `${count} open`,
  countPending: (count) => `${count} pending`,
  countUnassigned: (count) => `${count} unassigned`,
  countMine: (count) => `${count} mine`,
  queueSummary: (counts) =>
    `${counts.open} open, ${counts.pending} pending, ${counts.unassigned} unassigned, ${counts.mine} assigned to you`,
  loading: "Loading…",
  loadError: "Something went wrong. Try again.",
  selectTicket: (number) => `Select ticket #${number}`,
  selectAll: "Select all tickets",
  selectedCount: (count) => `${count} selected`,
  clearSelection: "Clear selection",
  bulkStatus: "Set status…",
  bulkPriority: "Set priority…",
  bulkAssignee: "Assign to…",
  tags: "Tags",
  addTag: "Add tag",
  removeTag: "Remove tag",
  removeTagNamed: (tag) => `Remove tag ${tag}`,
  tagPlaceholder: "Tag",
  noTags: "No tags",
  noPriority: "No priority",
  delete: "Delete",
  deleteTicket: "Delete ticket",
  confirmDelete: (count) =>
    count === 1
      ? "Delete this ticket and its messages? This cannot be undone."
      : `Delete ${count} tickets and their messages? This cannot be undone.`,
  confirmDeleteAction: "Yes, delete",
  cancel: "Cancel",
  selectPrompt: "Select a ticket",
  details: "Details",
  assignee: "Assignee",
  priorityField: "Priority",
  statusField: "Status",
  system: "System",
  unknownSender: "Unknown sender",
  unknownAgent: "Someone",
  noteBadge: "Note",
  internalBadge: "Internal",
  unverifiedBadge: "Unverified",
  eventStatus: (from, to) => `Status changed from ${from} to ${to}`,
  eventAssigned: (name) => `Assigned to ${name}`,
  eventUnassigned: "Unassigned",
  eventPriority: (priority) => `Priority set to ${priority}`,
  eventPriorityCleared: "Priority cleared",
  eventMerged: "Tickets merged",
  eventAttachmentDropped: "An attachment could not be stored",
  eventFollowup: "Follow-up to an earlier ticket",
  openAttachment: (filename) => `Open attachment ${filename}`,
  fileSize: (bytes) =>
    bytes < 1024
      ? `${bytes} B`
      : bytes < 1024 * 1024
        ? `${Math.round(bytes / 1024)} KB`
        : `${(bytes / (1024 * 1024)).toFixed(1)} MB`,
  composerLabel: "Write a message",
  modeLabel: "Message type",
  statusOnSend: "Status after sending",
  statusOnSendDefault: "Default status",
  removeAttachment: (filename) => `Remove ${filename}`,
  uploading: "Uploading…",
  uploadFailed: "The file could not be uploaded.",
  sendFailed: "The message could not be sent.",
  sending: "Sending…",
  cannedReplies: "Canned replies",
  cannedSearch: "Search canned replies",
  cannedEmpty: "No canned replies",
  cannedManage: "Manage",
  cannedTitle: "Title",
  cannedBody: "Text",
  cannedSave: "Save canned reply",
  cannedDelete: (title) => `Delete canned reply ${title}`,
  mention: "Mention",
  mentionAgent: (name) => `Mention ${name}`,
  merge: "Merge",
  mergeSearch: "Search by number or subject",
  mergeEmpty: "No tickets found",
  mergeInto: (number) => `Merge into #${number}`,
  confirmMerge: (source, target) =>
    `Merge #${source} into #${target}? The messages move to #${target} and #${source} closes.`,
  confirmMergeAction: "Yes, merge",
};
