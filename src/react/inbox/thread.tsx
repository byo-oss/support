import type { MouseEvent, ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { TicketPriority, TicketStatus } from "../../schema";
import type {
  SupportFetchClient,
  UseSupportQueueResult,
  WireAgentAttachment,
  WireAgentMessage,
  WireAgentTicket,
} from "../hooks";
import { useSupportAgentTicket } from "../hooks";
import { Composer } from "./composer";
import { DetailsPanel } from "./details";
import { Button, cx, toDate } from "./primitives";
import type { InboxLabels, SupportAgent } from "./types";

type ThreadPaneProps = {
  client: SupportFetchClient;
  ticketId: string;
  queue: UseSupportQueueResult;
  agents: SupportAgent[];
  labels: InboxLabels;
  pollInterval?: number | undefined;
  onNavigate?: ((href: string) => void) | undefined;
  renderMessage?:
    | ((message: WireAgentMessage, fallback: ReactNode) => ReactNode)
    | undefined;
  /** Back to the queue (narrow layout). */
  onBack: () => void;
  /**
   * The ticket shown was deleted. `id` is the open id the pane was mounted
   * for (`ticketId`), not the merge-resolved `ticket.id` it shows. Called
   * after the request settles, so the parent checks it is still the open one.
   */
  onGone: (id: string) => void;
  /**
   * The ticket shown was merged into `targetId`. `sourceId` is the open id
   * the pane was mounted for (`ticketId`), not the merge-resolved `ticket.id`
   * it shows. Called after the request settles, so the parent follows only
   * if `sourceId` is still the open one.
   */
  onMerged: (sourceId: string, targetId: string) => void;
  /**
   * The ticket the server answered for `openId` (`ticket.id`, which differs
   * from `openId` when that ticket was merged), so the parent can tell a
   * bulk delete of the shown ticket from one of another.
   */
  onResolved: (openId: string, id: string) => void;
  className?: string | undefined;
  messageClassName?: string | undefined;
  composerClassName?: string | undefined;
  buttonClassName?: string | undefined;
};

/** One ticket: header, messages and timeline, composer, side panel. */
export function ThreadPane({
  client,
  ticketId,
  queue,
  agents,
  labels,
  pollInterval,
  onNavigate,
  renderMessage,
  onBack,
  onGone,
  onMerged,
  onResolved,
  className,
  messageClassName,
  composerClassName,
  buttonClassName,
}: ThreadPaneProps) {
  const thread = useSupportAgentTicket(client, ticketId, {
    ...(pollInterval !== undefined ? { pollInterval } : {}),
  });
  const { ticket, messages } = thread;
  const resolvedId = ticket?.id ?? null;
  useEffect(() => {
    if (resolvedId !== null) onResolved(ticketId, resolvedId);
  }, [ticketId, resolvedId, onResolved]);
  const [sendFailed, setSendFailed] = useState(false);
  const refreshQueue = queue.refresh;

  // rows, counts and the unread announcement follow what happens in the thread
  const reply: typeof thread.reply = async (input) => {
    const ok = await thread.reply(input);
    if (ok) void refreshQueue();
    return ok;
  };
  const update: typeof thread.update = async (input) => {
    const ok = await thread.update(input);
    if (ok) void refreshQueue();
    return ok;
  };
  const [detailsOpen, setDetailsOpen] = useState(false);
  const attachmentsOn = queue.features.attachments;

  // viewing a ticket marks it seen, once per new message
  const seenKeyRef = useRef<string | null>(null);
  const markSeen = thread.markSeen;
  const unreadKey = ticket?.unread
    ? `${ticket.id}:${String(ticket.lastMessageAt)}`
    : null;
  useEffect(() => {
    if (unreadKey === null || seenKeyRef.current === unreadKey) return;
    seenKeyRef.current = unreadKey;
    void markSeen().then(() => refreshQueue());
  }, [unreadKey, markSeen, refreshQueue]);

  // keep the newest message in view
  const logRef = useRef<HTMLDivElement>(null);
  const lastMessageId = messages[messages.length - 1]?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the newest message changes
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lastMessageId]);

  const byMessage = useMemo(() => {
    const map = new Map<string, WireAgentAttachment[]>();
    for (const attachment of thread.attachments) {
      if (!attachment.messageId) continue;
      const list = map.get(attachment.messageId) ?? [];
      list.push(attachment);
      map.set(attachment.messageId, list);
    }
    return map;
  }, [thread.attachments]);

  const openAttachment = async (attachment: WireAgentAttachment) => {
    const blob = await thread.openAttachment(attachment.id);
    if (!blob) return;
    // saved, not rendered: a blob URL shares this page's origin, so an HTML
    // file must never be opened as a page
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = attachment.filename;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const agentName = (id: string | null | undefined) =>
    id ? (agents.find((agent) => agent.id === id)?.name ?? null) : null;

  const textFor = (message: WireAgentMessage): string => {
    const data = message.data;
    const status = (value: string | null | undefined) =>
      labels.status[value as TicketStatus] ?? value ?? "";
    switch (data?.type) {
      case "status":
        return labels.eventStatus(status(data.from), status(data.to));
      case "assignee":
        return data.to
          ? labels.eventAssigned(agentName(data.to) ?? labels.unknownAgent)
          : labels.eventUnassigned;
      case "priority":
        return data.to
          ? labels.eventPriority(
              labels.priority[data.to as TicketPriority] ?? data.to,
            )
          : labels.eventPriorityCleared;
      case "merged":
        return labels.eventMerged;
      case "attachment_dropped":
        return labels.eventAttachmentDropped;
      case "followup_of":
        return labels.eventFollowup;
      default:
        return message.body;
    }
  };

  const linkClick = (event: MouseEvent<HTMLAnchorElement>, href: string) => {
    if (!onNavigate) return;
    try {
      const url = new URL(href, window.location.href);
      if (url.origin !== window.location.origin) return;
      event.preventDefault();
      onNavigate(`${url.pathname}${url.search}${url.hash}`);
    } catch {
      // not a URL we can route; the browser handles it
    }
  };

  const renderBody = (text: string): ReactNode =>
    text.split(/(https?:\/\/[^\s<>"']+)/g).map((part, index) =>
      index % 2 === 1 ? (
        <a
          // biome-ignore lint/suspicious/noArrayIndexKey: parts have no identity
          key={index}
          href={part}
          target="_blank"
          rel="noopener noreferrer nofollow"
          onClick={(event) => linkClick(event, part)}
          className="underline"
        >
          {part}
        </a>
      ) : (
        part
      ),
    );

  const renderRow = (message: WireAgentMessage): ReactNode => {
    const when = labels.relativeTime(toDate(message.createdAt));
    let fallback: ReactNode;
    if (message.kind === "event") {
      fallback = (
        <p
          className={cx(
            "text-center text-xs text-muted-foreground",
            messageClassName,
          )}
        >
          {textFor(message)} · {when}
        </p>
      );
    } else {
      const note = message.kind === "note";
      const fromCustomer = message.authorType === "customer";
      const name =
        message.author?.name ??
        message.author?.email ??
        (message.authorType === "system"
          ? labels.system
          : labels.unknownSender);
      const files = attachmentsOn ? (byMessage.get(message.id) ?? []) : [];
      fallback = (
        <article
          className={cx(
            "flex max-w-[90%] flex-col gap-1 rounded-lg border px-3 py-2 text-sm",
            note
              ? "self-end border-dashed border-border bg-accent/60 text-accent-foreground"
              : fromCustomer
                ? "self-start border-border bg-muted text-foreground"
                : "self-end border-transparent bg-primary/10 text-foreground",
            messageClassName,
          )}
        >
          <header className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{name}</span>
            {note ? (
              <span className="rounded bg-background px-1.5 py-0.5">
                {labels.noteBadge}
              </span>
            ) : null}
            {!message.verified && fromCustomer ? (
              <span className="rounded bg-background px-1.5 py-0.5">
                {labels.unverifiedBadge}
              </span>
            ) : null}
            <span>{when}</span>
          </header>
          <p className="whitespace-pre-wrap break-words">
            {renderBody(message.body)}
          </p>
          {files.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5">
              {files.map((file) => (
                <li key={file.id}>
                  <button
                    type="button"
                    aria-label={labels.openAttachment(file.filename)}
                    onClick={() => void openAttachment(file)}
                    className="flex max-w-full items-center gap-1 rounded border border-border bg-background px-2 py-1 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="truncate">{file.filename}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {labels.fileSize(file.size)}
                    </span>
                    {file.internal ? (
                      <span className="shrink-0 rounded bg-muted px-1">
                        {labels.internalBadge}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </article>
      );
    }
    return renderMessage ? renderMessage(message, fallback) : fallback;
  };

  const requester = ticket
    ? (ticket.requester.name ?? ticket.requester.email ?? labels.unknownSender)
    : "";

  return (
    <section
      aria-label={ticket ? ticket.subject : labels.support}
      className={cx(
        "flex min-h-0 min-w-0 flex-col bg-background text-foreground lg:flex-row",
        className,
      )}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex items-start gap-2 border-b border-border p-3">
          <Button
            extra={buttonClassName}
            className="md:hidden"
            onClick={onBack}
          >
            {labels.back}
          </Button>
          <div className="min-w-0 flex-1">
            {ticket ? (
              <>
                <h2 className="truncate text-sm font-semibold">
                  <span className="mr-1 font-normal text-muted-foreground">
                    {labels.ticketNumber(ticket.number)}
                  </span>
                  {ticket.subject}
                </h2>
                <p className="truncate text-xs text-muted-foreground">
                  {requester} · {labels.status[ticket.status]}
                </p>
              </>
            ) : null}
          </div>
          <Button
            extra={buttonClassName}
            className="lg:hidden"
            aria-expanded={detailsOpen}
            onClick={() => setDetailsOpen((value) => !value)}
          >
            {labels.details}
          </Button>
        </header>

        {thread.error && !ticket ? (
          <p role="alert" className="p-3 text-sm text-destructive">
            {labels.loadError}
          </p>
        ) : null}
        {!ticket && !thread.error ? (
          <p className="p-3 text-sm text-muted-foreground">{labels.loading}</p>
        ) : null}

        {ticket ? (
          <>
            <div
              ref={logRef}
              role="log"
              aria-label={ticket.subject}
              className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3"
            >
              {messages.map((message) => (
                <div key={message.id} className="flex flex-col">
                  {renderRow(message)}
                </div>
              ))}
            </div>
            {thread.error && !sendFailed ? (
              <p role="alert" className="px-3 pb-2 text-sm text-destructive">
                {labels.loadError}
              </p>
            ) : null}
            <Composer
              client={client}
              ticketId={ticket.id}
              reply={reply}
              failed={sendFailed}
              onFailedChange={setSendFailed}
              agents={agents}
              attachments={attachmentsOn}
              labels={labels}
              className={composerClassName}
              buttonClassName={buttonClassName}
            />
          </>
        ) : null}
      </div>

      {ticket ? (
        <aside
          aria-label={labels.details}
          className={cx(
            "order-first border-b border-border bg-muted/30 lg:order-last lg:block lg:w-72 lg:shrink-0 lg:overflow-y-auto lg:border-b-0 lg:border-l",
            detailsOpen ? "block" : "hidden",
          )}
        >
          <DetailsPanel
            client={client}
            ticket={ticket as WireAgentTicket}
            update={update}
            agents={agents}
            tags={queue.tags}
            canMerge={queue.features.merge && typeof queue.merge === "function"}
            onMerge={async (target) => {
              const merge = queue.merge;
              if (!merge) return false;
              // the request acts on the ticket shown (merge-resolved); the
              // parent is told the open id it compares with
              const merged = await merge(ticket.id, target.id);
              if (!merged) return false;
              onMerged(ticketId, merged.id);
              return true;
            }}
            onDelete={async () => {
              const deleted = await queue.remove([ticket.id]);
              if (deleted === null) return false;
              onGone(ticketId);
              return true;
            }}
            labels={labels}
            buttonClassName={buttonClassName}
          />
        </aside>
      ) : null}
    </section>
  );
}
