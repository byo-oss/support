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
import { categoryIcon, Icon, StatusBadge, Time } from "../ui";
import {
  buttonBase,
  categoryLabels,
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
  /** New ticket, of a category picked from the empty list's cards or not yet chosen. */
  onNew: (category?: string) => void;
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
    <section className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="text-sm font-medium focus:outline-none"
        >
          {labels.myTickets}
        </h2>
        <button
          type="button"
          onClick={() => onNew()}
          className={cn(primaryButton, "gap-1.5")}
        >
          <Icon name="plus" />
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
        ) : tickets.tickets.length === 0 &&
          tickets.error === null &&
          tickets.features.categories.length > 0 ? (
          <div className="flex flex-col gap-3 p-4">
            <p className="text-sm font-medium">{labels.chooseCategory}</p>
            <CategoryCards
              categories={tickets.features.categories}
              labels={labels}
              onPick={onNew}
            />
          </div>
        ) : tickets.tickets.length === 0 && tickets.error === null ? (
          <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
            <span className="mb-1 flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Icon name="message" className="size-5" />
            </span>
            <p className="text-sm font-medium">{labels.empty}</p>
            <p className="text-xs text-muted-foreground">{labels.emptyHint}</p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {tickets.tickets.map((ticket) => (
              <li key={ticket.id}>
                <button
                  type="button"
                  onClick={() => onOpen(ticket.id)}
                  className={cn(
                    "relative flex w-full items-start gap-2 px-4 py-3 text-left hover:bg-accent/50",
                    focusRing,
                    TOUCH_TARGET,
                  )}
                >
                  {ticket.status === "pending" ? (
                    <span
                      aria-hidden
                      className="absolute inset-y-0 left-0 w-0.5 bg-primary"
                    />
                  ) : null}
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span
                        className={cn(
                          "min-w-0 flex-1 break-words text-sm",
                          ticket.unread ? "font-semibold" : "font-medium",
                        )}
                      >
                        {ticket.unread ? (
                          <span
                            aria-hidden
                            className="mb-px mr-1.5 inline-block size-2 rounded-full bg-primary align-middle"
                          />
                        ) : null}
                        {ticket.subject}
                      </span>
                      <Time
                        value={ticket.lastMessageAt}
                        labels={labels}
                        className="shrink-0 text-[11px] text-muted-foreground"
                      />
                    </span>
                    <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                      <span className="tabular-nums">
                        {labels.ticketNumber(ticket.number)}
                      </span>
                      <StatusBadge
                        status={ticket.status}
                        label={labels.customerStatus[ticket.status]}
                      />
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

/** The kinds of support as cards: two columns, one on a narrow panel. */
export function CategoryCards({
  categories,
  labels,
  onPick,
}: {
  categories: string[];
  labels: WidgetLabels;
  onPick: (category: string) => void;
}) {
  return (
    <ul className="grid grid-cols-1 gap-2 min-[340px]:grid-cols-2">
      {categories.map((category) => {
        const { title, hint } = categoryLabels(labels, category);
        return (
          <li key={category}>
            <button
              type="button"
              onClick={() => onPick(category)}
              className={cn(
                "flex h-full w-full flex-col items-start gap-1.5 rounded-lg border border-border bg-background p-3 text-left hover:border-primary/40 hover:bg-accent/50",
                focusRing,
                TOUCH_TARGET,
              )}
            >
              <span className="flex size-8 items-center justify-center rounded-md bg-muted text-foreground">
                <Icon name={categoryIcon(category)} />
              </span>
              <span className="text-sm font-medium">{title}</span>
              {hint ? (
                <span className="text-xs text-muted-foreground">{hint}</span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export type NewTicketViewProps = {
  tickets: UseSupportTicketsResult;
  /** Picked on the list's cards; unset shows the cards first (when the server offers categories). */
  category?: string | undefined;
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
  category: initialCategory,
  labels,
  organizationId,
  onBack,
  onCreated,
  focusOnMount,
  className,
  composerClassName,
  fieldClassName,
}: NewTicketViewProps) {
  const categories = tickets.features.categories;
  const [category, setCategory] = useState<string | null>(
    initialCategory && categories.includes(initialCategory)
      ? initialCategory
      : null,
  );
  const choosing = categories.length > 0 && category === null;
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
  // moving between the cards and the form: focus the new heading
  const firstStep = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the step changes
  useEffect(() => {
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [choosing]);

  const wording = category ? categoryLabels(labels, category) : null;
  const valid = subject.trim().length > 0 && body.trim().length > 0;

  const submit = async () => {
    if (!valid || sending) return;
    setSending(true);
    try {
      const ticket = await tickets.createTicket({
        subject: subject.trim(),
        body: body.trim(),
        ...(category ? { category } : {}),
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
    <section className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <button
          type="button"
          // from the form, Back returns to the cards it was picked on
          onClick={() =>
            categories.length > 0 && !choosing ? setCategory(null) : onBack()
          }
          className={cn(buttonBase, "gap-1")}
        >
          <Icon name="back" />
          {labels.back}
        </button>
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="flex min-w-0 items-center gap-2 text-sm font-medium focus:outline-none"
        >
          {wording && category ? (
            <Icon
              name={categoryIcon(category)}
              className="size-4 shrink-0 text-muted-foreground"
            />
          ) : null}
          <span className="truncate">
            {choosing
              ? labels.chooseCategory
              : (wording?.title ?? labels.newTicket)}
          </span>
        </h2>
      </header>
      {choosing ? (
        <div className="min-h-0 overflow-y-auto p-4">
          <CategoryCards
            categories={categories}
            labels={labels}
            onPick={setCategory}
          />
        </div>
      ) : (
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
            placeholder={wording?.placeholder ?? labels.messagePlaceholder}
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
      )}
    </section>
  );
}
