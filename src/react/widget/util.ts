import { defaultLabels, type SupportLabels } from "../labels";
import { defaultWidgetLabels, type SupportWidgetLabels } from "./labels";

/** Every string the widget shows: the shared keys plus its own. */
export type WidgetLabels = SupportLabels & SupportWidgetLabels;

/** Joins the truthy class names. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** Defaults, then the app's overrides. The `status` and `priority` maps merge key by key. */
export function resolveWidgetLabels(
  overrides: Partial<WidgetLabels> | undefined,
): WidgetLabels {
  const merged: WidgetLabels = {
    ...defaultLabels,
    ...defaultWidgetLabels,
    ...stripUndefined(overrides),
  };
  merged.status = { ...defaultLabels.status, ...overrides?.status };
  merged.priority = { ...defaultLabels.priority, ...overrides?.priority };
  return merged;
}

function stripUndefined<T extends object>(value: T | undefined): Partial<T> {
  if (!value) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

/**
 * Whether to offer the requester-only actions (solve, reopen, rate, share).
 * An organization teammate viewing a shared ticket is not its requester, and
 * the server refuses those actions for them.
 */
export function canActAsRequester(ticket: { isRequester: boolean }): boolean {
  return ticket.isRequester;
}

export const MAX_ATTACHMENTS = 10;

export const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** Default look of the widget's own buttons. `buttonClassName` replaces the trigger's look only. */
export const buttonBase = `inline-flex items-center justify-center rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`;
export const primaryButton = `inline-flex items-center justify-center rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`;
export const fieldBase = `w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground ${focusRing}`;
