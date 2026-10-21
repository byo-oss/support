import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
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
  /** Poll interval in ms. @default 15000 */
  pollInterval?: number;
  /** Shared keys (`SupportLabels`) plus this component's own. */
  labels?: Partial<SupportLabels & SupportInboxLabels>;
  className?: string;
  queueClassName?: string;
  threadClassName?: string;
  messageClassName?: string;
  composerClassName?: string;
  buttonClassName?: string;
};

const SEARCH_DEBOUNCE_MS = 250;

const defaultNavigate = (href: string) => window.location.assign(href);

/**
 * The agent inbox: queue with filters, thread, reply/note toggle, canned
 * replies, @mentions, attachments, status/priority/assignee/tags, bulk
 * update, merge and delete (attachment and merge UI hidden when their
 * `features` flag is false).
 *
 * Narrow screens show the queue or the thread, one at a time; from `md` up
 * they sit side by side. Enter writes a new line, Ctrl/Cmd+Enter sends.
 */
export function SupportInbox({
  client,
  agents,
  onNavigate,
  renderMessage,
  pollInterval,
  labels: labelOverrides,
  className,
  queueClassName,
  threadClassName,
  messageClassName,
  composerClassName,
  buttonClassName,
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

  const [openId, setOpenId] = useState<string | null>(null);
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
        onOpenTicket={setOpenId}
        checked={checked}
        onCheckedChange={setChecked}
        onDeleted={(ids) => {
          // a deleted ticket must not stay on screen with a live composer
          if (openId !== null && ids.includes(openId)) setOpenId(null);
        }}
        buttonClassName={buttonClassName}
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
          onBack={() => setOpenId(null)}
          onGone={() => setOpenId(null)}
          onOpenTicket={setOpenId}
          className={cx("flex-1", threadClassName)}
          messageClassName={messageClassName}
          composerClassName={composerClassName}
          buttonClassName={buttonClassName}
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
