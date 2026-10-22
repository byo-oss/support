import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { TOUCH_TARGET } from "../classes";
import {
  type SupportFetchClient,
  useSupportTickets,
  type WireCustomerMessage,
} from "../hooks";
import type { SupportLabels } from "../labels";
import { Icon } from "../ui";
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
   * the new-ticket form). Sync your URL here. A ticket created after the
   * user left its form (Back) is neither opened nor reported.
   */
  onTicketChange?: (ticketId: string | null) => void;
  /** Popover only: whether the panel starts open. @default Boolean(ticketId) */
  defaultOpen?: boolean;
  /**
   * Popover only: controls whether the panel is open; pair it with
   * `onOpenChange`. When the app opens the panel (closed to open, not from
   * the launcher) while `ticketId` is set, the panel shows that ticket's
   * thread, so the same link can open it again after the user closed it.
   * A launcher click the app declines (keeping `open` false) doesn't count
   * as the launcher for the app's own later open. Set `open` from
   * `onOpenChange` in the same event: an `open` that turns true in a later
   * render (after an await, in a transition, through a router navigation)
   * counts as the app opening the panel and shows `ticketId`'s thread.
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
  /**
   * Added to the root's classes (the panel itself for `inline`). Every class
   * prop appends. Buttons, fields and rows are at least 44px tall on a coarse
   * pointer (touch).
   */
  className?: string;
  listClassName?: string;
  threadClassName?: string;
  messageClassName?: string;
  composerClassName?: string;
  /** Added to the launcher's classes (popover only). */
  buttonClassName?: string;
  /** Added to every text input and textarea (not checkboxes or the file input). */
  fieldClassName?: string;
};

type View =
  | { name: "list" }
  | { name: "new"; category?: string }
  | { name: "thread"; ticketId: string };

const defaultNavigate = (href: string) => window.location.assign(href);

const DEFAULT_BADGE_POLL_INTERVAL = 60_000;

const LAUNCHER_CLASS = `relative inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground hover:bg-accent ${focusRing} ${TOUCH_TARGET}`;

const PANEL_CLASS =
  "flex flex-col overflow-hidden rounded-xl border border-border bg-background text-foreground";

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
  fieldClassName,
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
  // the view on screen, by identity: a create that settles after the user
  // left its form (Back, or the app's ticketId) must not pull them away
  const viewRef = useRef(view);
  viewRef.current = view;
  const onTicketChangeRef = useRef(onTicketChange);
  onTicketChangeRef.current = onTicketChange;
  // an inline widget's first view leaves focus where the page put it; a
  // view the user moves to takes focus
  const navigated = useRef(false);
  // a request that settles after unmount (a slow create, then the user
  // navigates away) must not move the app's URL back to the ticket
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  /** A view the user moved to: tell the app when the open ticket changed, so it can sync its URL. */
  const go = useCallback((next: View) => {
    if (!mounted.current) return;
    navigated.current = true;
    viewRef.current = next;
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
    // the refs too: a continuation that lands before the re-render compares
    // with the view now on screen
    if (!next) {
      if (viewRef.current.name !== "thread") return;
      const list: View = { name: "list" };
      viewRef.current = list;
      openIdRef.current = null;
      setView(list);
      return;
    }
    const thread: View = { name: "thread", ticketId: next };
    viewRef.current = thread;
    openIdRef.current = next;
    setView(thread);
    if (!inline && !openRef.current) setOpen(true);
  }, [ticketId, inline, setOpen]);

  // the app opening the panel (not the launcher) shows the linked ticket,
  // so the same link works again after the user closed the panel. A launcher
  // click counts only for the render it causes: when a controlled app
  // declines it (keeps `open` false), the flag is cleared there, so the
  // app's own later open still shows the linked ticket.
  const launcherOpened = useRef(false);
  const [launcherClicks, setLauncherClicks] = useState(0);
  const wasOpen = useRef(open);
  // biome-ignore lint/correctness/useExhaustiveDependencies: launcherClicks re-runs it after every launcher click, to clear the flag
  useEffect(() => {
    const opened = open && !wasOpen.current;
    wasOpen.current = open;
    const fromLauncher = launcherOpened.current;
    launcherOpened.current = false;
    if (!opened || fromLauncher || !ticketId) return;
    const thread: View = { name: "thread", ticketId };
    viewRef.current = thread;
    openIdRef.current = ticketId;
    setView(thread);
  }, [open, ticketId, launcherClicks]);

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
          onNew={(category) =>
            go(category ? { name: "new", category } : { name: "new" })
          }
          focusOnMount={focusOnMount}
          className={listClassName}
        />
      ) : null}
      {view.name === "new" ? (
        <NewTicketView
          tickets={tickets}
          category={view.category}
          labels={labels}
          organizationId={organizationId}
          onBack={backToList}
          onCreated={(ticketId) => {
            // `view` is the form this create was sent from; once the user
            // left it, the new ticket just shows up in the list
            if (viewRef.current !== view) return;
            go({ name: "thread", ticketId });
          }}
          focusOnMount={focusOnMount}
          className={listClassName}
          composerClassName={composerClassName}
          fieldClassName={fieldClassName}
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
          fieldClassName={fieldClassName}
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
          setLauncherClicks((clicks) => clicks + 1);
          setOpen(!open);
        }}
        className={cn(LAUNCHER_CLASS, buttonClassName)}
      >
        <Icon name="message" />
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
            "absolute right-0 z-50 mt-2 max-h-[min(80vh,36rem)] w-[calc(100vw-2rem)] max-w-[22.5rem] shadow-xl",
            // a thread keeps one height, so its reply box stays put as
            // messages load; the list, the cards and the form fit their content
            view.name === "thread" && "h-[min(80vh,36rem)]",
          )}
        >
          {panelContent}
        </div>
      ) : null}
    </div>
  );
}
