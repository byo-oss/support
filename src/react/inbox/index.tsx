import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SupportFetchClient, WireAgentMessage } from "../hooks";
import { useSupportQueue } from "../hooks";
import { defaultLabels, type SupportLabels } from "../labels";
import { defaultInboxLabels, type SupportInboxLabels } from "./labels";
import { cx } from "./primitives";
import { type QueueFilters, QueuePane } from "./queue";
import { ThreadPane } from "./thread";
import type { InboxLabels, SupportAgent } from "./types";

export type { SupportAgent } from "./types";

export type SupportInboxProps = {
  client: SupportFetchClient;
  agents: SupportAgent[];
  /** Called with in-app links; route with your router. Default: `location.assign`. */
  onNavigate?: (href: string) => void;
  /** Render one message; `fallback` is the default rendering. */
  renderMessage?: (message: WireAgentMessage, fallback: ReactNode) => ReactNode;
  /**
   * Opens this ticket's thread, for deep links (`/staff/support/:id`). A new
   * value opens that ticket; `null` or `undefined` after a ticket closes the
   * thread. Changes from this prop never call `onTicketChange`.
   */
  ticketId?: string | null;
  /**
   * Called when the user changes the open ticket (selecting a row, Back, a
   * merge that moves to the target, deleting the open ticket) with its id,
   * or `null` when no ticket is open. Sync your URL here. A merge or delete
   * that settles after the user opened another ticket leaves that ticket
   * open and reports nothing; nothing is reported after unmount.
   */
  onTicketChange?: (ticketId: string | null) => void;
  /** Poll interval in ms. 0 disables polling. @default 15000 */
  pollInterval?: number;
  /** Shared keys (`SupportLabels`) plus this component's own. */
  labels?: Partial<SupportLabels & SupportInboxLabels>;
  /**
   * Added to the root's classes. Every class prop appends. Buttons, fields
   * and rows are at least 44px tall on a coarse pointer (touch).
   */
  className?: string;
  queueClassName?: string;
  threadClassName?: string;
  messageClassName?: string;
  composerClassName?: string;
  buttonClassName?: string;
  /** Added to every text input, select and textarea (not checkboxes, radios or the file input). */
  fieldClassName?: string;
};

const SEARCH_DEBOUNCE_MS = 250;

const defaultNavigate = (href: string) => window.location.assign(href);

/**
 * The staff inbox: queue with filters, thread, reply/note toggle, canned
 * replies, @mentions, attachments, status/priority/assignee/tags, bulk
 * update, merge and delete (attachment and merge UI hidden when their
 * `features` flag is false).
 *
 * `ticketId` opens a ticket from your URL and `onTicketChange` reports the
 * user's selection back, for deep links like `/staff/support/:id`.
 *
 * Narrow screens show the queue or the thread, one at a time; from `md` up
 * they sit side by side. Enter writes a new line, Ctrl/Cmd+Enter sends.
 */
export function SupportInbox({
  client,
  agents,
  onNavigate,
  renderMessage,
  ticketId,
  onTicketChange,
  pollInterval,
  labels: labelOverrides,
  className,
  queueClassName,
  threadClassName,
  messageClassName,
  composerClassName,
  buttonClassName,
  fieldClassName,
}: SupportInboxProps): ReactNode {
  const labels = useMemo<InboxLabels>(
    () => ({
      ...defaultLabels,
      ...defaultInboxLabels,
      ...labelOverrides,
      status: { ...defaultLabels.status, ...labelOverrides?.status },
      priority: { ...defaultLabels.priority, ...labelOverrides?.priority },
    }),
    [labelOverrides],
  );

  const [filters, setFilters] = useState<QueueFilters>({
    status: "",
    assignee: "",
    tag: "",
  });
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQ(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  const queue = useSupportQueue(client, {
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.assignee ? { assignee: filters.assignee } : {}),
    ...(filters.tag ? { tag: filters.tag } : {}),
    ...(q ? { q } : {}),
    ...(pollInterval !== undefined ? { pollInterval } : {}),
  });

  const [openId, setOpenId] = useState<string | null>(ticketId ?? null);
  const openIdRef = useRef(openId);
  openIdRef.current = openId;
  const onTicketChangeRef = useRef(onTicketChange);
  onTicketChangeRef.current = onTicketChange;
  // a delete or merge that settles after unmount (the agent navigated away)
  // must not move the app's URL
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // the ticket the open pane shows, for the open id it was answered for: a
  // merged source shows its target, and deleting that target closes it
  const resolvedRef = useRef<{ openId: string; id: string } | null>(null);
  const onResolved = useCallback((openId: string, id: string) => {
    resolvedRef.current = { openId, id };
  }, []);
  /** A selection the user made: tell the app, so it can sync its URL. */
  const select = useCallback((id: string | null) => {
    if (!mounted.current || openIdRef.current === id) return;
    openIdRef.current = id;
    setOpenId(id);
    onTicketChangeRef.current?.(id);
  }, []);

  // the prop opens its ticket when it changes (a deep link, or the app's
  // router after onTicketChange); an app that never passes it keeps the
  // inbox's own selection
  const linked = useRef(ticketId ?? null);
  useEffect(() => {
    const next = ticketId ?? null;
    if (linked.current === next) return;
    linked.current = next;
    // the ref too: a continuation that lands before the re-render compares
    // with the ticket now open
    openIdRef.current = next;
    setOpenId(next);
  }, [ticketId]);
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());

  // the live region sits at the root: on narrow screens the queue is hidden
  // while a thread is open, and a hidden region is never announced
  const unread = queue.tickets.filter((ticket) => ticket.unread).length;
  const announcement = [
    unread > 0 ? labels.unreadCount(unread) : "",
    labels.queueSummary(queue.counts),
  ]
    .filter(Boolean)
    .join(". ");

  return (
    <div
      className={cx(
        "flex min-h-[28rem] w-full min-w-0 flex-col rounded-lg border border-border bg-background text-foreground md:flex-row",
        className,
      )}
    >
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
      <QueuePane
        queue={queue}
        labels={labels}
        agents={agents}
        filters={filters}
        onFiltersChange={setFilters}
        search={search}
        onSearchChange={setSearch}
        selectedTicketId={openId}
        onOpenTicket={select}
        checked={checked}
        onCheckedChange={setChecked}
        onDeleted={(ids) => {
          // a deleted ticket must not stay on screen with a live composer;
          // read at resolve time: the agent may have opened another meanwhile
          const open = openIdRef.current;
          if (open === null) return;
          const shown = resolvedRef.current;
          if (
            ids.includes(open) ||
            (shown?.openId === open && ids.includes(shown.id))
          ) {
            select(null);
          }
        }}
        buttonClassName={buttonClassName}
        fieldClassName={fieldClassName}
        className={cx(
          openId ? "hidden md:flex" : "flex",
          "w-full border-b border-border md:w-80 md:shrink-0 md:border-b-0 md:border-r",
          queueClassName,
        )}
      />
      {openId ? (
        <ThreadPane
          key={openId}
          client={client}
          ticketId={openId}
          queue={queue}
          agents={agents}
          labels={labels}
          pollInterval={pollInterval}
          onNavigate={onNavigate ?? defaultNavigate}
          renderMessage={renderMessage}
          onBack={() => select(null)}
          onGone={(id) => {
            // `id` is the open id the pane was mounted for, even when it
            // shows a merge target; act only if the agent is still on it:
            // they may have opened another ticket while the delete was in flight
            if (openIdRef.current === id) select(null);
          }}
          onMerged={(sourceId, targetId) => {
            // follow to the target only from the ticket that was merged
            if (openIdRef.current === sourceId) select(targetId);
          }}
          onResolved={onResolved}
          className={cx("flex-1", threadClassName)}
          messageClassName={messageClassName}
          composerClassName={composerClassName}
          buttonClassName={buttonClassName}
          fieldClassName={fieldClassName}
        />
      ) : (
        <div
          className={cx(
            "hidden flex-1 items-center justify-center p-6 text-sm text-muted-foreground md:flex",
            threadClassName,
          )}
        >
          {labels.selectPrompt}
        </div>
      )}
    </div>
  );
}
