import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { TicketPriority, TicketStatus } from "../../schema";
import { TOUCH_ICON, TOUCH_TARGET } from "../classes";
import type { UseSupportQueueResult, WireAgentTicket } from "../hooks";
import {
  Avatar,
  asDate,
  Icon,
  PriorityBadge,
  StatusBadge,
  TagPill,
  Time,
} from "../ui";
import { Button, buttonClass, Confirm, cx, fieldClass } from "./primitives";
import type { InboxLabels, SupportAgent } from "./types";

export const STATUSES = ["open", "pending", "solved", "closed"] as const;
export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;

export type QueueFilters = {
  status: TicketStatus | "";
  /** `""` everyone, `"me"`, `"none"` or an agent id. */
  assignee: string;
  tag: string;
};

type QueuePaneProps = {
  queue: UseSupportQueueResult;
  labels: InboxLabels;
  agents: SupportAgent[];
  filters: QueueFilters;
  onFiltersChange: (filters: QueueFilters) => void;
  search: string;
  onSearchChange: (value: string) => void;
  selectedTicketId: string | null;
  onOpenTicket: (id: string) => void;
  /** Ids ticked for a bulk action. */
  checked: ReadonlySet<string>;
  onCheckedChange: (checked: Set<string>) => void;
  /** Called with the ids once a bulk delete went through. */
  onDeleted: (ids: string[]) => void;
  /** Opens the keyboard shortcuts sheet. */
  onShortcuts: () => void;
  className?: string | undefined;
  buttonClassName?: string | undefined;
  fieldClassName?: string | undefined;
};

const UNASSIGN = "__none__";
const CLEAR_PRIORITY = "__none__";

/** The queue: filters, counts, rows with checkboxes, bulk bar, load more. */
export function QueuePane({
  queue,
  labels,
  agents,
  filters,
  onFiltersChange,
  search,
  onSearchChange,
  selectedTicketId,
  onOpenTicket,
  checked,
  onCheckedChange,
  onDeleted,
  onShortcuts,
  className,
  buttonClassName,
  fieldClassName,
}: QueuePaneProps) {
  const { tickets, counts } = queue;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [tagDraft, setTagDraft] = useState("");

  // ticked rows that left the list (deleted, filtered out) stop counting
  const checkedIds = useMemo(
    () => tickets.filter((t) => checked.has(t.id)).map((t) => t.id),
    [tickets, checked],
  );
  const allChecked = tickets.length > 0 && checkedIds.length === tickets.length;

  // when the thread closes (Back), put focus back on its row
  const lastOpenedRef = useRef<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (selectedTicketId) {
      lastOpenedRef.current = selectedTicketId;
      return;
    }
    const id = lastOpenedRef.current;
    if (!id) return;
    lastOpenedRef.current = null;
    for (const row of listRef.current?.querySelectorAll<HTMLElement>(
      "[data-ticket-id]",
    ) ?? []) {
      if (row.dataset.ticketId === id) row.focus();
    }
  }, [selectedTicketId]);

  const toggle = (id: string, on: boolean) => {
    const next = new Set(checkedIds);
    if (on) next.add(id);
    else next.delete(id);
    onCheckedChange(next);
  };

  const agentName = (id: string) =>
    agents.find((agent) => agent.id === id)?.name;

  const chip = (
    text: string,
    active: boolean,
    apply: () => void,
  ): ReactNode => (
    <button
      key={text}
      type="button"
      aria-pressed={active}
      onClick={apply}
      className={cx(
        "rounded-full border px-2.5 py-0.5 text-xs font-medium tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        TOUCH_TARGET,
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {text}
    </button>
  );

  const filtered =
    filters.status !== "" ||
    filters.assignee !== "" ||
    filters.tag !== "" ||
    search.trim() !== "";

  const bulk = (input: Parameters<UseSupportQueueResult["update"]>[1]) =>
    void queue.update(checkedIds, input);

  return (
    <section
      aria-label={labels.queue}
      className={cx(
        // the parent decides `flex` or `hidden md:flex`
        "min-h-0 min-w-0 flex-col bg-background text-foreground",
        className,
      )}
    >
      <div className="flex flex-col gap-2 border-b border-border p-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Icon
              name="inbox"
              className="size-4 shrink-0 text-muted-foreground"
            />
            {labels.queue}
          </h2>
          <button
            type="button"
            onClick={onShortcuts}
            title={labels.shortcuts}
            aria-keyshortcuts="?"
            className={cx(
              "inline-flex items-center justify-center rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              TOUCH_ICON,
            )}
          >
            <Icon name="keyboard" />
            <span className="sr-only">{labels.shortcuts}</span>
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {chip(labels.countOpen(counts.open), filters.status === "open", () =>
            onFiltersChange({
              ...filters,
              status: filters.status === "open" ? "" : "open",
            }),
          )}
          {chip(
            labels.countPending(counts.pending),
            filters.status === "pending",
            () =>
              onFiltersChange({
                ...filters,
                status: filters.status === "pending" ? "" : "pending",
              }),
          )}
          {chip(
            labels.countUnassigned(counts.unassigned),
            filters.assignee === "none",
            () =>
              onFiltersChange({
                ...filters,
                assignee: filters.assignee === "none" ? "" : "none",
              }),
          )}
          {chip(labels.countMine(counts.mine), filters.assignee === "me", () =>
            onFiltersChange({
              ...filters,
              assignee: filters.assignee === "me" ? "" : "me",
            }),
          )}
        </div>
        <div className="relative">
          <Icon
            name="search"
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="search"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            aria-label={labels.search}
            placeholder={labels.search}
            className={fieldClass(fieldClassName, "w-full pl-8")}
          />
        </div>
        <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-3">
          <select
            aria-label={labels.filterStatus}
            value={filters.status}
            onChange={(event) =>
              onFiltersChange({
                ...filters,
                status: event.target.value as TicketStatus | "",
              })
            }
            className={fieldClass(fieldClassName)}
          >
            <option value="">{labels.allStatuses}</option>
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {labels.status[status]}
              </option>
            ))}
          </select>
          <select
            aria-label={labels.filterAssignee}
            value={filters.assignee}
            onChange={(event) =>
              onFiltersChange({ ...filters, assignee: event.target.value })
            }
            className={fieldClass(fieldClassName)}
          >
            <option value="">{labels.allAssignees}</option>
            <option value="me">{labels.assignedToMe}</option>
            <option value="none">{labels.unassigned}</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
          <select
            aria-label={labels.filterTag}
            value={filters.tag}
            onChange={(event) =>
              onFiltersChange({ ...filters, tag: event.target.value })
            }
            className={fieldClass(fieldClassName)}
          >
            <option value="">{labels.allTags}</option>
            {queue.tags.map((tag) => (
              <option key={tag} value={tag}>
                {tag}
              </option>
            ))}
          </select>
        </div>
      </div>

      {checkedIds.length > 0 ? (
        <div className="flex flex-col gap-2 border-b border-border bg-muted/50 p-3">
          <div className="flex items-center justify-between gap-2 text-sm">
            <span>{labels.selectedCount(checkedIds.length)}</span>
            <Button
              extra={buttonClassName}
              onClick={() => {
                onCheckedChange(new Set());
                setConfirmDelete(false);
              }}
            >
              {labels.clearSelection}
            </Button>
          </div>
          <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-3">
            <select
              aria-label={labels.bulkStatus}
              value=""
              onChange={(event) => {
                if (event.target.value)
                  bulk({ status: event.target.value as TicketStatus });
              }}
              className={fieldClass(fieldClassName)}
            >
              <option value="">{labels.bulkStatus}</option>
              {STATUSES.map((status) => (
                <option key={status} value={status}>
                  {labels.status[status]}
                </option>
              ))}
            </select>
            <select
              aria-label={labels.bulkPriority}
              value=""
              onChange={(event) => {
                const value = event.target.value;
                if (!value) return;
                bulk({
                  priority:
                    value === CLEAR_PRIORITY ? null : (value as TicketPriority),
                });
              }}
              className={fieldClass(fieldClassName)}
            >
              <option value="">{labels.bulkPriority}</option>
              {PRIORITIES.map((priority) => (
                <option key={priority} value={priority}>
                  {labels.priority[priority]}
                </option>
              ))}
              <option value={CLEAR_PRIORITY}>{labels.noPriority}</option>
            </select>
            <select
              aria-label={labels.bulkAssignee}
              value=""
              onChange={(event) => {
                const value = event.target.value;
                if (!value) return;
                bulk({ assigneeId: value === UNASSIGN ? null : value });
              }}
              className={fieldClass(fieldClassName)}
            >
              <option value="">{labels.bulkAssignee}</option>
              <option value={UNASSIGN}>{labels.unassigned}</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </div>
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const tag = tagDraft.trim();
              if (tag) bulk({ addTags: [tag] });
              setTagDraft("");
            }}
          >
            <input
              type="text"
              list="support-inbox-bulk-tags"
              value={tagDraft}
              onChange={(event) => setTagDraft(event.target.value)}
              aria-label={labels.tagPlaceholder}
              placeholder={labels.tagPlaceholder}
              className={fieldClass(fieldClassName, "flex-1")}
            />
            <datalist id="support-inbox-bulk-tags">
              {queue.tags.map((tag) => (
                <option key={tag} value={tag} />
              ))}
            </datalist>
            <button
              type="submit"
              disabled={!tagDraft.trim()}
              className={buttonClass("default", buttonClassName)}
            >
              {labels.addTag}
            </button>
            <Button
              extra={buttonClassName}
              disabled={!tagDraft.trim()}
              onClick={() => {
                const tag = tagDraft.trim();
                if (tag) bulk({ removeTags: [tag] });
                setTagDraft("");
              }}
            >
              {labels.removeTag}
            </Button>
          </form>
          {confirmDelete ? (
            <Confirm
              message={labels.confirmDelete(checkedIds.length)}
              confirmLabel={labels.confirmDeleteAction}
              cancelLabel={labels.cancel}
              buttonClassName={buttonClassName}
              onCancel={() => setConfirmDelete(false)}
              onConfirm={() => {
                setConfirmDelete(false);
                const ids = checkedIds;
                void queue.remove(ids).then((deleted) => {
                  if (deleted === null) return;
                  onCheckedChange(new Set());
                  onDeleted(ids);
                });
              }}
            />
          ) : (
            <div>
              <Button
                variant="danger"
                extra={buttonClassName}
                onClick={() => setConfirmDelete(true)}
              >
                {labels.delete}
              </Button>
            </div>
          )}
        </div>
      ) : null}

      {queue.error ? (
        <p role="alert" className="px-3 py-2 text-sm text-destructive">
          {labels.loadError}
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {tickets.length > 0 ? (
          <label
            className={cx(
              "flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-muted-foreground",
              TOUCH_TARGET,
            )}
          >
            <input
              type="checkbox"
              checked={allChecked}
              onChange={(event) =>
                onCheckedChange(
                  event.target.checked
                    ? new Set(tickets.map((t) => t.id))
                    : new Set(),
                )
              }
            />
            <span>{labels.selectAll}</span>
          </label>
        ) : null}
        {tickets.length === 0 && queue.isLoading ? (
          <div>
            <p className="sr-only">{labels.loading}</p>
            <ul aria-hidden="true" className="divide-y divide-border">
              {[0, 1, 2, 3, 4].map((row) => (
                <li key={row} className="flex gap-3 px-3 py-3">
                  <span className="size-7 shrink-0 animate-pulse rounded-full bg-muted motion-reduce:animate-none" />
                  <span className="flex flex-1 flex-col gap-2">
                    <span className="h-3 w-3/4 animate-pulse rounded bg-muted motion-reduce:animate-none" />
                    <span className="h-2.5 w-1/2 animate-pulse rounded bg-muted motion-reduce:animate-none" />
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : tickets.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
            <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Icon name="inbox" className="size-5" />
            </span>
            {filtered ? (
              <>
                <p className="text-sm text-muted-foreground">
                  {labels.emptyFiltered}
                </p>
                <Button
                  extra={buttonClassName}
                  onClick={() => {
                    onFiltersChange({ status: "", assignee: "", tag: "" });
                    onSearchChange("");
                  }}
                >
                  {labels.clearFilters}
                </Button>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">{labels.empty}</p>
            )}
          </div>
        ) : (
          <ul ref={listRef} className="divide-y divide-border">
            {tickets.map((ticket) => (
              <QueueRow
                key={ticket.id}
                ticket={ticket}
                labels={labels}
                active={ticket.id === selectedTicketId}
                checked={checkedIds.includes(ticket.id)}
                assignee={
                  ticket.assignee?.name ??
                  (ticket.assigneeId ? agentName(ticket.assigneeId) : undefined)
                }
                onToggle={(on) => toggle(ticket.id, on)}
                onOpen={() => onOpenTicket(ticket.id)}
              />
            ))}
          </ul>
        )}
        {queue.hasMore ? (
          <div className="border-t border-border p-2">
            <Button
              extra={buttonClassName}
              className="w-full"
              onClick={() => void queue.loadMore()}
            >
              {labels.loadMore}
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function QueueRow({
  ticket,
  labels,
  active,
  checked,
  assignee,
  onToggle,
  onOpen,
}: {
  ticket: WireAgentTicket;
  labels: InboxLabels;
  active: boolean;
  checked: boolean;
  assignee: string | undefined;
  onToggle: (on: boolean) => void;
  onOpen: () => void;
}) {
  const requester =
    ticket.requester.name ?? ticket.requester.email ?? labels.unknownSender;
  const loud = ticket.priority === "high" || ticket.priority === "urgent";
  return (
    <li
      className={cx(
        "relative flex items-start gap-2 py-2.5 pl-3 pr-3",
        active ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
      )}
    >
      {active ? (
        <span
          aria-hidden="true"
          className="absolute inset-y-0 left-0 w-0.5 bg-primary"
        />
      ) : null}
      {/* the label widens the checkbox's hit area on a touch screen */}
      <label className="flex shrink-0 cursor-pointer justify-center pt-1.5 pointer-coarse:-my-2 pointer-coarse:-ml-3 pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:items-center pointer-coarse:pt-0">
        <input
          type="checkbox"
          aria-label={labels.selectTicket(ticket.number)}
          checked={checked}
          onChange={(event) => onToggle(event.target.checked)}
        />
      </label>
      <button
        type="button"
        data-ticket-id={ticket.id}
        aria-current={active ? "true" : undefined}
        onClick={onOpen}
        className={cx(
          "flex min-w-0 flex-1 gap-2.5 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          TOUCH_TARGET,
        )}
      >
        <Avatar
          name={ticket.requester.name ?? ticket.requester.email}
          image={ticket.requester.image}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex items-baseline gap-2">
            <span
              className={cx(
                "min-w-0 flex-1 truncate text-sm",
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
              className={cx(
                "shrink-0 text-[11px] tabular-nums",
                ticket.unread
                  ? "font-medium text-foreground"
                  : "text-muted-foreground",
              )}
            />
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="shrink-0 tabular-nums">
              {labels.ticketNumber(ticket.number)}
            </span>
            <span aria-hidden>·</span>
            <span className="truncate">{requester}</span>
            {ticket.channel === "email" ? (
              <Icon name="mail" className="size-3 shrink-0" />
            ) : null}
          </span>
          <span className="flex flex-wrap items-center gap-1">
            <StatusBadge
              status={ticket.status}
              label={labels.status[ticket.status]}
            />
            {ticket.status === "open" ? (
              <WaitingPill
                since={asDate(ticket.lastMessageAt)}
                labels={labels}
              />
            ) : null}
            {ticket.priority && loud ? (
              <PriorityBadge
                priority={ticket.priority}
                label={labels.priority[ticket.priority]}
              />
            ) : ticket.priority ? (
              <span className="sr-only">
                {labels.priority[ticket.priority]}
              </span>
            ) : null}
            {assignee ? (
              <span className="inline-flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
                <Avatar
                  name={assignee}
                  image={ticket.assignee?.image}
                  size="xs"
                  tone="primary"
                />
                <span className="truncate">{assignee}</span>
              </span>
            ) : null}
            {ticket.tags.map((tag) => (
              <TagPill key={tag}>{tag}</TagPill>
            ))}
          </span>
        </span>
      </button>
    </li>
  );
}

const HOUR = 60 * 60 * 1000;
/** Amber from 6 hours, red from a day: better-helpdesk's thresholds. */
const WAIT_WARN_MS = 6 * HOUR;
const WAIT_LATE_MS = 24 * HOUR;

/**
 * How long an open ticket has waited for the team. Only replies move
 * `lastMessageAt`, and a customer reply sets the status to open, so on an
 * open ticket it is when the customer last wrote.
 */
function WaitingPill({ since, labels }: { since: Date; labels: InboxLabels }) {
  const waited = Date.now() - since.getTime();
  if (Number.isNaN(waited)) return null;
  const tone =
    waited >= WAIT_LATE_MS
      ? "border-destructive/40 bg-destructive/10 text-destructive"
      : waited >= WAIT_WARN_MS
        ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
        : "border-border text-muted-foreground";
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 tabular-nums ${tone}`}
    >
      {labels.waitingFor(since)}
    </span>
  );
}
