import type { MouseEvent, MutableRefObject, ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { TicketPriority, TicketStatus } from "../../schema";
import { TOUCH_TARGET } from "../classes";
import type {
  SupportFetchClient,
  UseSupportQueueResult,
  WireAgentAttachment,
  WireAgentMessage,
  WireAgentTicket,
} from "../hooks";
import { downloadAttachment, useSupportAgentTicket } from "../hooks";
import {
  Avatar,
  canPreview,
  Icon,
  ImagePreview,
  PriorityBadge,
  StatusBadge,
  Time,
} from "../ui";
import {
  Composer,
  type ComposerCommands,
  type ComposerDrafts,
} from "./composer";
import { DetailsPanel } from "./details";
import { Button, cx } from "./primitives";
import type { InboxLabels, SupportAgent } from "./types";

/** What the inbox's shortcuts ask of the open thread. */
export type ThreadActions = {
  /** Mark the ticket solved (the `e` shortcut). */
  solve: () => void;
};

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
  /** Unsent text by ticket, kept by the inbox across thread panes. */
  drafts?: ComposerDrafts | undefined;
  /** Filled with the composer's commands, for the inbox's shortcuts. */
  commandsRef?: MutableRefObject<ComposerCommands | null> | undefined;
  /** Filled with this pane's actions, for the inbox's shortcuts. */
  actionsRef?: MutableRefObject<ThreadActions | null> | undefined;
  className?: string | undefined;
  messageClassName?: string | undefined;
  composerClassName?: string | undefined;
  buttonClassName?: string | undefined;
  fieldClassName?: string | undefined;
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
  drafts,
  commandsRef,
  actionsRef,
  className,
  messageClassName,
  composerClassName,
  buttonClassName,
  fieldClassName,
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
  const solveRef = useRef<() => void>(() => {});
  solveRef.current = () => {
    if (ticket && ticket.status !== "solved" && ticket.status !== "closed")
      void update({ status: "solved" });
  };
  useEffect(() => {
    if (!actionsRef) return;
    actionsRef.current = { solve: () => solveRef.current() };
    return () => {
      actionsRef.current = null;
    };
  }, [actionsRef]);

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

  // a preview that fails stays a placeholder: it must not raise the
  // thread's error banner (the file chip under it still downloads)
  const previewAttachment = (id: string) =>
    downloadAttachment(client, "/support/agent/attachment", id, () => {});

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
    let fallback: ReactNode;
    if (message.kind === "event") {
      fallback = (
        <p
          className={cx(
            "flex items-center gap-3 py-1 text-center text-xs text-muted-foreground",
            messageClassName,
          )}
        >
          <span aria-hidden="true" className="h-px flex-1 bg-border" />
          <span className="max-w-[80%]">
            {textFor(message)} ·{" "}
            <Time value={message.createdAt} labels={labels} />
          </span>
          <span aria-hidden="true" className="h-px flex-1 bg-border" />
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
      const images = files.filter(canPreview);
      fallback = (
        <article
          className={cx(
            "flex max-w-[92%] gap-2 sm:max-w-[85%]",
            fromCustomer ? "self-start" : "flex-row-reverse self-end",
            messageClassName,
          )}
        >
          <Avatar
            name={name}
            image={message.author?.image}
            tone={fromCustomer ? "muted" : "primary"}
          />
          <div
            className={cx(
              "flex min-w-0 flex-col gap-1",
              fromCustomer ? "items-start" : "items-end",
            )}
          >
            <header className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{name}</span>
              {note ? (
                <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 font-medium text-amber-800 dark:text-amber-300">
                  <Icon name="lock" className="size-3 shrink-0" />
                  {labels.noteBadge}
                </span>
              ) : null}
              {!message.verified && fromCustomer ? (
                <span className="inline-flex items-center gap-1 rounded bg-destructive/10 px-1.5 py-0.5 text-destructive">
                  <Icon name="alert" className="size-3 shrink-0" />
                  {labels.unverifiedBadge}
                </span>
              ) : null}
              {message.channel === "email" ? (
                <span className="inline-flex items-center gap-1">
                  <Icon name="mail" className="size-3 shrink-0" />
                  {labels.viaEmail}
                </span>
              ) : null}
              <Time value={message.createdAt} labels={labels} />
            </header>
            <div
              className={cx(
                "w-fit max-w-full rounded-2xl px-3.5 py-2 text-sm leading-relaxed",
                note
                  ? "rounded-tr-sm border border-dashed border-amber-500/60 bg-amber-500/10 text-foreground"
                  : fromCustomer
                    ? "rounded-tl-sm bg-muted text-foreground"
                    : "rounded-tr-sm bg-primary text-primary-foreground",
              )}
            >
              <p className="whitespace-pre-wrap break-words">
                {renderBody(message.body)}
              </p>
            </div>
            {images.length > 0 ? (
              <ul className="flex flex-wrap gap-1.5">
                {images.map((file) => (
                  <li key={file.id}>
                    <ImagePreview
                      id={file.id}
                      load={previewAttachment}
                      alt={labels.imagePreview(file.filename)}
                      onOpen={() => void openAttachment(file)}
                    />
                  </li>
                ))}
              </ul>
            ) : null}
            {files.length > 0 ? (
              <ul className="flex flex-wrap gap-1.5">
                {files.map((file) => (
                  <li key={file.id}>
                    <button
                      type="button"
                      aria-label={labels.openAttachment(file.filename)}
                      onClick={() => void openAttachment(file)}
                      className={cx(
                        "flex max-w-full items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        TOUCH_TARGET,
                      )}
                    >
                      <Icon
                        name="paperclip"
                        className="size-3.5 shrink-0 text-muted-foreground"
                      />
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
          </div>
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
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2.5">
          <Button
            extra={buttonClassName}
            className="md:hidden"
            onClick={onBack}
          >
            <Icon name="back" />
            {labels.back}
          </Button>
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            {ticket ? (
              <>
                <span className="hidden sm:inline-flex">
                  <Avatar
                    name={ticket.requester.name ?? ticket.requester.email}
                    image={ticket.requester.image}
                    size="md"
                  />
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-sm font-semibold sm:text-base">
                    <span className="mr-1.5 font-normal text-muted-foreground">
                      {labels.ticketNumber(ticket.number)}
                    </span>
                    {ticket.subject}
                  </h2>
                  <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="truncate">{requester}</span>
                    <span aria-hidden>·</span>
                    <StatusBadge
                      status={ticket.status}
                      label={labels.status[ticket.status]}
                    />
                    {ticket.priority === "high" ||
                    ticket.priority === "urgent" ? (
                      <PriorityBadge
                        priority={ticket.priority}
                        label={labels.priority[ticket.priority]}
                      />
                    ) : null}
                  </p>
                </div>
              </>
            ) : null}
          </div>
          <Button
            extra={buttonClassName}
            className="lg:hidden"
            aria-expanded={detailsOpen}
            onClick={() => setDetailsOpen((value) => !value)}
          >
            <Icon name="panel" />
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
              className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-4 sm:px-4"
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
              status={ticket.status}
              drafts={drafts}
              commandsRef={commandsRef}
              labels={labels}
              className={composerClassName}
              buttonClassName={buttonClassName}
              fieldClassName={fieldClassName}
            />
          </>
        ) : null}
      </div>

      {ticket ? (
        <aside
          aria-label={labels.details}
          className={cx(
            "order-first max-h-[60%] overflow-y-auto border-b border-border bg-muted/30 lg:order-last lg:block lg:max-h-none lg:w-80 lg:shrink-0 lg:border-b-0 lg:border-l",
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
            fieldClassName={fieldClassName}
          />
        </aside>
      ) : null}
    </section>
  );
}
