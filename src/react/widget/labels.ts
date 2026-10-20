// BYO_STUB: final owner N12b. Add the widget's own label keys here (never rename or remove one).
// Shared keys live in ../labels.ts (N12a); the widget takes Partial<SupportLabels & SupportWidgetLabels>.

/** Strings only `SupportWidget` shows. */
export type SupportWidgetLabels = {
  /** Heading of the customer's ticket list. */
  myTickets: string;
};

export const defaultWidgetLabels: SupportWidgetLabels = {
  myTickets: "My tickets",
};
