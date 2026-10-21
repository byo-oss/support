import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { TOUCH_TARGET } from "../classes";
import type { UseSupportTicketsResult } from "../hooks";
import {
  buttonBase,
  cn,
  fieldBase,
  focusRing,
  primaryButton,
  type WidgetLabels,
} from "./util";

export type ListViewProps = {
  tickets: UseSupportTicketsResult;
  labels: WidgetLabels;
  onOpen: (id: string) => void;
  onNew: () => void;
  /** Move focus to the heading on mount (off for an inline widget's first view). */
  focusOnMount: boolean;
  className: string | undefined;
};

export function ListView({
  tickets,
  labels,
  onOpen,
  onNew,
  focusOnMount,
  className,
}: ListViewProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusRef = useRef(focusOnMount);
  useEffect(() => {
    if (focusRef.current) headingRef.current?.focus();
  }, []);
  const loading = tickets.isLoading && tickets.tickets.length === 0;

  return (
    <section className={cn("flex min-h-0 flex-col", className)}>
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="text-sm font-medium focus:outline-none"
        >
          {labels.myTickets}
        </h2>
        <button type="button" onClick={onNew} className={primaryButton}>
          {labels.newTicket}
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {tickets.error !== null ? (
          <p role="alert" className="px-3 py-2 text-sm text-destructive">
            {labels.somethingWrong}
          </p>
        ) : null}
        {loading ? (
          <p
            role="status"
            className="px-3 py-8 text-center text-sm text-muted-foreground"
          >
            {labels.loading}
          </p>
        ) : tickets.tickets.length === 0 && tickets.error === null ? (
          <p className="px-3 py-8 text-center text-sm text-muted-foreground">
            {labels.empty}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {tickets.tickets.map((ticket) => (
              <li key={ticket.id}>
                <button
                  type="button"
                  onClick={() => onOpen(ticket.id)}
                  className={cn(
                    "flex w-full items-start gap-2 px-3 py-2.5 text-left hover:bg-accent/50",
                    focusRing,
                    TOUCH_TARGET,
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "mt-1.5 size-2 shrink-0 rounded-full",
                      ticket.unread ? "bg-primary" : "bg-transparent",
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        "block break-words text-sm",
                        ticket.unread ? "font-semibold" : "font-medium",
                      )}
                    >
                      <span className="text-muted-foreground">
                        {labels.ticketNumber(ticket.number)}
                      </span>{" "}
                      {ticket.subject}
                    </span>
                    <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                      <span>{labels.status[ticket.status]}</span>
                      <span>{labels.relativeTime(ticket.lastMessageAt)}</span>
                      {ticket.unread ? (
                        <span className="sr-only">{labels.unreadTicket}</span>
                      ) : null}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {tickets.hasMore ? (
        <button
          type="button"
          onClick={() => void tickets.loadMore()}
          className={cn(
            "border-t border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground",
            focusRing,
            TOUCH_TARGET,
          )}
        >
          {labels.loadMore}
        </button>
      ) : null}
    </section>
  );
}

export type NewTicketViewProps = {
  tickets: UseSupportTicketsResult;
  labels: WidgetLabels;
  organizationId: string | undefined;
  onBack: () => void;
  onCreated: (id: string) => void;
  /** Move focus to the heading on mount. */
  focusOnMount: boolean;
  className: string | undefined;
  composerClassName: string | undefined;
  fieldClassName: string | undefined;
};

export function NewTicketView({
  tickets,
  labels,
  organizationId,
  onBack,
  onCreated,
  focusOnMount,
  className,
  composerClassName,
  fieldClassName,
}: NewTicketViewProps) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [share, setShare] = useState(false);
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const subjectId = useId();
  const bodyId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusRef = useRef(focusOnMount);
  useEffect(() => {
    if (focusRef.current) headingRef.current?.focus();
  }, []);

  const valid = subject.trim().length > 0 && body.trim().length > 0;

  const submit = async () => {
    if (!valid || sending) return;
    setSending(true);
    try {
      const ticket = await tickets.createTicket({
        subject: subject.trim(),
        body: body.trim(),
        ...(organizationId
          ? {
              organizationId,
              visibility: share
                ? ("organization" as const)
                : ("private" as const),
            }
          : {}),
      });
      setFailed(ticket === null);
      if (ticket) onCreated(ticket.id);
    } finally {
      setSending(false);
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void submit();
  };
  // Enter in the subject, or Ctrl/Cmd+Enter in the message, submits
  const onSubjectKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void submit();
    }
  };
  const onBodyKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <section className={cn("flex min-h-0 flex-col", className)}>
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <button type="button" onClick={onBack} className={buttonBase}>
          {labels.back}
        </button>
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="text-sm font-medium focus:outline-none"
        >
          {labels.newTicket}
        </h2>
      </header>
      <form
        onSubmit={onSubmit}
        className={cn(
          "flex min-h-0 flex-col gap-2 overflow-y-auto p-3",
          composerClassName,
        )}
      >
        <label htmlFor={subjectId} className="text-sm font-medium">
          {labels.subject}
        </label>
        <input
          id={subjectId}
          type="text"
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
          onKeyDown={onSubjectKey}
          maxLength={200}
          required
          className={cn(fieldBase, fieldClassName)}
        />
        <label htmlFor={bodyId} className="text-sm font-medium">
          {labels.message}
        </label>
        <textarea
          id={bodyId}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={onBodyKey}
          placeholder={labels.messagePlaceholder}
          rows={5}
          maxLength={50_000}
          required
          className={cn(fieldBase, "resize-y", fieldClassName)}
        />
        {organizationId ? (
          <label
            className={cn("flex items-center gap-2 text-sm", TOUCH_TARGET)}
          >
            <input
              type="checkbox"
              checked={share}
              onChange={(event) => setShare(event.target.checked)}
              className={focusRing}
            />
            {labels.shareWithOrganization}
          </label>
        ) : null}
        {failed ? (
          <p role="alert" className="text-sm text-destructive">
            {labels.somethingWrong}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={!valid || sending}
          className={cn(primaryButton, "self-end")}
        >
          {labels.createTicket}
        </button>
      </form>
    </section>
  );
}
