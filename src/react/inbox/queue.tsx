import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { TicketPriority, TicketStatus } from "../../schema";
import { TOUCH_TARGET } from "../classes";
import type { UseSupportQueueResult, WireAgentTicket } from "../hooks";
import {
  Button,
  buttonClass,
  Confirm,
  cx,
  fieldClass,
  toDate,
} from "./primitives";
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
        "rounded-full border border-border px-2 py-0.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        TOUCH_TARGET,
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {text}
    </button>
  );

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
        <h2 className="text-sm font-semibold">{labels.queue}</h2>
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
        <input
          type="search"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          aria-label={labels.search}
          placeholder={labels.search}
          className={fieldClass(fieldClassName, "w-full")}
        />
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
        {tickets.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-muted-foreground">
            {queue.isLoading ? labels.loading : labels.empty}
          </p>
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
  return (
    <li
      className={cx(
        "flex items-start gap-2 px-3 py-2",
        active ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
      )}
    >
      {/* the label widens the checkbox's hit area on a touch screen */}
      <label className="flex shrink-0 cursor-pointer justify-center pointer-coarse:-my-2 pointer-coarse:-ml-3 pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:items-center">
        <input
          type="checkbox"
          className="mt-1 pointer-coarse:mt-0"
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
          "min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          TOUCH_TARGET,
        )}
      >
        <span className="flex items-center gap-1.5">
          {ticket.unread ? (
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full bg-primary"
            />
          ) : null}
          <span className="shrink-0 text-xs text-muted-foreground">
            {labels.ticketNumber(ticket.number)}
          </span>
          <span
            className={cx(
              "truncate text-sm",
              ticket.unread ? "font-semibold" : "font-medium",
            )}
          >
            {ticket.subject}
          </span>
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <span className="truncate">{requester}</span>
          <span>{labels.status[ticket.status]}</span>
          {ticket.priority ? (
            <span>{labels.priority[ticket.priority]}</span>
          ) : null}
          {assignee ? <span>{assignee}</span> : null}
          <span>{labels.relativeTime(toDate(ticket.lastMessageAt))}</span>
        </span>
        {ticket.tags.length > 0 ? (
          <span className="mt-1 flex flex-wrap gap-1">
            {ticket.tags.map((tag) => (
              <span
                key={tag}
                className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
              >
                {tag}
              </span>
            ))}
          </span>
        ) : null}
      </button>
    </li>
  );
}
