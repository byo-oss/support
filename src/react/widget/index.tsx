import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  type SupportFetchClient,
  useSupportTickets,
  type WireCustomerMessage,
} from "../hooks";
import type { SupportLabels } from "../labels";
import type { SupportWidgetLabels } from "./labels";
import { ListView, NewTicketView } from "./list";
import { ThreadView } from "./thread";
import { cn, focusRing, resolveWidgetLabels } from "./util";

export type SupportWidgetProps = {
  client: SupportFetchClient;
  /** Called with in-app links; route with your router. Default: `location.assign`. */
  onNavigate?: (href: string) => void;
  /** Render one message; `fallback` is the default rendering. */
  renderMessage?: (
    message: WireCustomerMessage,
    fallback: ReactNode,
  ) => ReactNode;
  /** Organization for new tickets and "share with my organization". */
  organizationId?: string;
  /**
   * Opens the panel on this ticket's thread, for links from emails (route
   * `ticketPath(id)` to a page that renders `<SupportWidget ticketId={id} />`).
   * A new value opens that ticket; Back still goes to the list. A ticket the
   * caller can't read shows the thread's error state.
   */
  ticketId?: string;
  /** Poll interval in ms. @default 15000 */
  pollInterval?: number;
  /** Shared keys (`SupportLabels`) plus this component's own. */
  labels?: Partial<SupportLabels & SupportWidgetLabels>;
  className?: string;
  listClassName?: string;
  threadClassName?: string;
  messageClassName?: string;
  composerClassName?: string;
  buttonClassName?: string;
};

type View =
  | { name: "list" }
  | { name: "new" }
  | { name: "thread"; ticketId: string };

const defaultNavigate = (href: string) => window.location.assign(href);

const DEFAULT_BUTTON_CLASS = `relative inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground hover:bg-accent ${focusRing}`;

/**
 * The customer widget: ticket list, new ticket, thread, reply with
 * attachments (hidden when `features.attachments` is false), solve/reopen,
 * rate, share with the organization.
 *
 * A launcher button (with the unread count) opens the panel. Escape or a
 * click outside closes it, and Escape returns focus to the launcher. With
 * `ticketId` the panel starts open on that ticket's thread.
 */
export function SupportWidget({
  client,
  onNavigate,
  renderMessage,
  organizationId,
  ticketId,
  pollInterval,
  labels: labelOverrides,
  className,
  listClassName,
  threadClassName,
  messageClassName,
  composerClassName,
  buttonClassName,
}: SupportWidgetProps): ReactNode {
  const labels = resolveWidgetLabels(labelOverrides);
  // the list is the customer's own and org-shared tickets; `organizationId`
  // is for new tickets and sharing, so it does not filter the list
  const tickets = useSupportTickets(
    client,
    pollInterval === undefined ? {} : { pollInterval },
  );
  const { refresh } = tickets;

  const [open, setOpen] = useState(Boolean(ticketId));
  const [view, setView] = useState<View>(
    ticketId ? { name: "thread", ticketId } : { name: "list" },
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const countId = useId();

  // a deep link (or a new one, on client-side navigation) opens its ticket
  const linked = useRef(ticketId);
  useEffect(() => {
    if (linked.current === ticketId) return;
    linked.current = ticketId;
    if (!ticketId) return;
    setView({ name: "thread", ticketId });
    setOpen(true);
  }, [ticketId]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // opening is a deliberate look: show what arrived since the last poll
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const backToList = useCallback(() => {
    setView({ name: "list" });
    void refresh();
  }, [refresh]);

  const unreadCount = tickets.tickets.filter((ticket) => ticket.unread).length;

  return (
    <div
      ref={containerRef}
      className={cn("relative inline-block max-w-full", className)}
    >
      <button
        type="button"
        ref={triggerRef}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-describedby={countId}
        onClick={() => setOpen((value) => !value)}
        className={cn(buttonClassName ?? DEFAULT_BUTTON_CLASS)}
      >
        {labels.support}
        {unreadCount > 0 ? (
          <span
            aria-hidden
            className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium text-primary-foreground"
          >
            {unreadCount}
          </span>
        ) : null}
      </button>
      {/* outside the button, so its accessible name stays the label alone */}
      <span id={countId} className="sr-only" aria-live="polite">
        {unreadCount > 0 ? labels.unreadCount(unreadCount) : ""}
      </span>

      {open ? (
        <div
          id={panelId}
          role="dialog"
          aria-label={labels.support}
          className="absolute right-0 z-50 mt-2 flex max-h-[min(80vh,40rem)] w-[calc(100vw-2rem)] max-w-[22.5rem] flex-col overflow-hidden rounded-lg border border-border bg-background text-foreground shadow-md"
        >
          {view.name === "list" ? (
            <ListView
              tickets={tickets}
              labels={labels}
              onOpen={(ticketId) => setView({ name: "thread", ticketId })}
              onNew={() => setView({ name: "new" })}
              className={listClassName}
            />
          ) : null}
          {view.name === "new" ? (
            <NewTicketView
              tickets={tickets}
              labels={labels}
              organizationId={organizationId}
              onBack={backToList}
              onCreated={(ticketId) => setView({ name: "thread", ticketId })}
              className={listClassName}
              composerClassName={composerClassName}
            />
          ) : null}
          {view.name === "thread" ? (
            <ThreadView
              key={view.ticketId}
              client={client}
              ticketId={view.ticketId}
              labels={labels}
              attachmentsEnabled={tickets.features.attachments}
              pollInterval={pollInterval}
              onNavigate={onNavigate ?? defaultNavigate}
              renderMessage={renderMessage}
              onChanged={refresh}
              onBack={backToList}
              className={threadClassName}
              messageClassName={messageClassName}
              composerClassName={composerClassName}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
