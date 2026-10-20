// BYO_STUB: final owner N12c. Add the inbox's own label keys here (never rename or remove one).
// Shared keys live in ../labels.ts (N12a); the inbox takes Partial<SupportLabels & SupportInboxLabels>.

/** Strings only `SupportInbox` shows. */
export type SupportInboxLabels = {
  /** Heading of the agent queue. */
  queue: string;
};

export const defaultInboxLabels: SupportInboxLabels = {
  queue: "Queue",
};
