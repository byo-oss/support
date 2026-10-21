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
   * `"popover"`: a launcher button with the unread count opens the panel
   * below it, right-aligned; meant for a header. `"inline"`: the panel in
   * place at the full width of its container, always open, with no
   * launcher; meant for a page of its own ("my tickets", email deep links).
   * @default "popover"
   */
  variant?: "popover" | "inline";
  /**
   * Opens this ticket's thread, for links from emails (route `ticketPath(id)`
   * to a page that renders `<SupportWidget variant="inline" ticketId={id} />`).
   * A popover starts open unless `defaultOpen` or `open` says otherwise. A new
   * value opens that ticket; `null` or `undefined` after a ticket goes back to
   * the list. Back still goes to the list. A ticket the caller can't read
   * shows the thread's error state. Changes from this prop never call
   * `onTicketChange`.
   */
  ticketId?: string | null;
  /**
   * Called when the user changes the open ticket (opening a row, creating a
   * ticket, Back) with its id, or `null` when no ticket is open (the list or
   * the new-ticket form). Sync your URL here.
   */
  onTicketChange?: (ticketId: string | null) => void;
  /** Popover only: whether the panel starts open. @default Boolean(ticketId) */
  defaultOpen?: boolean;
  /**
   * Popover only: controls whether the panel is open; pair it with
   * `onOpenChange`. When the app opens the panel (closed to open, not from
   * the launcher) while `ticketId` is set, the panel shows that ticket's
   * thread, so the same link can open it again after the user closed it.
   */
  open?: boolean;
  /**
   * Popover only: called when the launcher, Escape, a click outside or a new
   * `ticketId` asks to open or close the panel.
   */
  onOpenChange?: (open: boolean) => void;
  /**
   * Poll interval in ms while the panel is open (always, for `inline`): the
   * ticket list and the open thread. 0 disables polling. @default 15000
   */
  pollInterval?: number;
  /**
   * Popover only: poll interval in ms for the ticket list while the panel is
   * closed, which keeps the launcher's unread count fresh. 0 disables it.
   * @default 60000
   */
  badgePollInterval?: number;
  /** Shared keys (`SupportLabels`) plus this component's own. */
  labels?: Partial<SupportLabels & SupportWidgetLabels>;
  /** Added to the root's classes (the panel itself for `inline`). Every class prop appends. */
  className?: string;
  listClassName?: string;
  threadClassName?: string;
  messageClassName?: string;
  composerClassName?: string;
  /** Added to the launcher's classes (popover only). */
  buttonClassName?: string;
};

type View =
  | { name: "list" }
  | { name: "new" }
  | { name: "thread"; ticketId: string };

const defaultNavigate = (href: string) => window.location.assign(href);

const DEFAULT_BADGE_POLL_INTERVAL = 60_000;

const LAUNCHER_CLASS = `relative inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground hover:bg-accent ${focusRing}`;

const PANEL_CLASS =
  "flex flex-col overflow-hidden rounded-lg border border-border bg-background text-foreground";

/**
 * The customer widget: ticket list, new ticket, thread, reply with
 * attachments (hidden when `features.attachments` is false), solve/reopen,
 * rate, share with the organization.
 *
 * As a popover, a launcher button (with the unread count) opens the panel.
 * Escape or a click outside closes it, and Escape returns focus to the
 * launcher. With `ticketId` the panel starts open on that ticket's thread.
 * Inline, the panel renders in place and never closes.
 */
export function SupportWidget({
  client,
  onNavigate,
  renderMessage,
  organizationId,
  variant = "popover",
  ticketId,
  onTicketChange,
  defaultOpen,
  open: openProp,
  onOpenChange,
  pollInterval,
  badgePollInterval = DEFAULT_BADGE_POLL_INTERVAL,
  labels: labelOverrides,
  className,
  listClassName,
  threadClassName,
  messageClassName,
  composerClassName,
  buttonClassName,
}: SupportWidgetProps): ReactNode {
  const labels = resolveWidgetLabels(labelOverrides);
  const inline = variant === "inline";

  const [openState, setOpenState] = useState(defaultOpen ?? Boolean(ticketId));
  const controlled = openProp !== undefined;
  const open = inline || (controlled ? openProp : openState);

  const controlledRef = useRef(controlled);
  controlledRef.current = controlled;
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  const openRef = useRef(open);
  openRef.current = open;
  const setOpen = useCallback((next: boolean) => {
    if (!controlledRef.current) setOpenState(next);
    onOpenChangeRef.current?.(next);
  }, []);

  // the list is the customer's own and org-shared tickets; `organizationId`
  // is for new tickets and sharing, so it does not filter the list. A closed
  // popover only needs the unread count, so it polls less often.
  const listPollInterval = open ? pollInterval : badgePollInterval;
  const tickets = useSupportTickets(
    client,
    listPollInterval === undefined ? {} : { pollInterval: listPollInterval },
  );
  const { refresh } = tickets;

  const [view, setView] = useState<View>(
    ticketId ? { name: "thread", ticketId } : { name: "list" },
  );
  // the open ticket as last shown, whoever changed it: the prop's changes
  // update it too, so the user's next move is compared with what's on screen
  const openId = view.name === "thread" ? view.ticketId : null;
  const openIdRef = useRef(openId);
  openIdRef.current = openId;
  const onTicketChangeRef = useRef(onTicketChange);
  onTicketChangeRef.current = onTicketChange;
  // an inline widget's first view leaves focus where the page put it; a
  // view the user moves to takes focus
  const navigated = useRef(false);
  /** A view the user moved to: tell the app when the open ticket changed, so it can sync its URL. */
  const go = useCallback((next: View) => {
    navigated.current = true;
    setView(next);
    const id = next.name === "thread" ? next.ticketId : null;
    if (openIdRef.current === id) return;
    openIdRef.current = id;
    onTicketChangeRef.current?.(id);
  }, []);
  const focusOnMount = !inline || navigated.current;

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const countId = useId();

  // a deep link (or a new one, on client-side navigation) opens its ticket;
  // the link going away (the app's router after Back, or the browser's)
  // leaves the thread for the list. Never reported to onTicketChange.
  const linked = useRef(ticketId ?? null);
  useEffect(() => {
    const next = ticketId ?? null;
    if (linked.current === next) return;
    linked.current = next;
    if (!next) {
      setView((current) =>
        current.name === "thread" ? { name: "list" } : current,
      );
      return;
    }
    setView({ name: "thread", ticketId: next });
    if (!inline && !openRef.current) setOpen(true);
  }, [ticketId, inline, setOpen]);

  // the app opening the panel (not the launcher) shows the linked ticket,
  // so the same link works again after the user closed the panel
  const launcherOpened = useRef(false);
  const wasOpen = useRef(open);
  useEffect(() => {
    const opened = open && !wasOpen.current;
    wasOpen.current = open;
    if (!opened) return;
    if (launcherOpened.current) {
      launcherOpened.current = false;
      return;
    }
    if (ticketId) setView({ name: "thread", ticketId });
  }, [open, ticketId]);

  useEffect(() => {
    if (inline || !open) return;
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
  }, [inline, open, setOpen]);

  // opening is a deliberate look: show what arrived since the last poll
  useEffect(() => {
    if (open && !inline) void refresh();
  }, [open, inline, refresh]);

  const backToList = useCallback(() => {
    go({ name: "list" });
    void refresh();
  }, [go, refresh]);

  const unreadCount = tickets.tickets.filter((ticket) => ticket.unread).length;

  const panelContent = (
    <>
      {view.name === "list" ? (
        <ListView
          tickets={tickets}
          labels={labels}
          onOpen={(ticketId) => go({ name: "thread", ticketId })}
          onNew={() => go({ name: "new" })}
          focusOnMount={focusOnMount}
          className={listClassName}
        />
      ) : null}
      {view.name === "new" ? (
        <NewTicketView
          tickets={tickets}
          labels={labels}
          organizationId={organizationId}
          onBack={backToList}
          onCreated={(ticketId) => go({ name: "thread", ticketId })}
          focusOnMount={focusOnMount}
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
          focusOnMount={focusOnMount}
          className={threadClassName}
          messageClassName={messageClassName}
          composerClassName={composerClassName}
        />
      ) : null}
    </>
  );

  if (inline) {
    return (
      <section
        aria-label={labels.support}
        className={cn(PANEL_CLASS, "w-full min-w-0", className)}
      >
        <span className="sr-only" aria-live="polite">
          {unreadCount > 0 ? labels.unreadCount(unreadCount) : ""}
        </span>
        {panelContent}
      </section>
    );
  }

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
        onClick={() => {
          launcherOpened.current = !open;
          setOpen(!open);
        }}
        className={cn(LAUNCHER_CLASS, buttonClassName)}
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
          className={cn(
            PANEL_CLASS,
            "absolute right-0 z-50 mt-2 max-h-[min(80vh,40rem)] w-[calc(100vw-2rem)] max-w-[22.5rem] shadow-md",
          )}
        >
          {panelContent}
        </div>
      ) : null}
    </div>
  );
}
