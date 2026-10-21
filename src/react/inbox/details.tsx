import { useState } from "react";
import type { TicketPriority, TicketStatus } from "../../schema";
import { TOUCH_ICON } from "../classes";
import type {
  SupportFetchClient,
  UseSupportAgentTicketResult,
  WireAgentTicket,
} from "../hooks";
import { Avatar, Icon, Time } from "../ui";
import { MergeControl } from "./merge";
import {
  Button,
  buttonClass,
  Confirm,
  cx,
  fieldClass,
  toDate,
} from "./primitives";
import { PRIORITIES, STATUSES } from "./queue";
import type { InboxLabels, SupportAgent } from "./types";

type DetailsPanelProps = {
  client: SupportFetchClient;
  ticket: WireAgentTicket;
  update: UseSupportAgentTicketResult["update"];
  agents: SupportAgent[];
  /** Every tag in use, for suggestions. */
  tags: string[];
  /** Merge is on (`features.merge` and the client method exist). */
  canMerge: boolean;
  onMerge: (target: WireAgentTicket) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
  labels: InboxLabels;
  className?: string | undefined;
  buttonClassName?: string | undefined;
  fieldClassName?: string | undefined;
};

const NONE = "";

/** The ticket side panel: status, priority, assignee, tags, merge, delete. */
export function DetailsPanel({
  client,
  ticket,
  update,
  agents,
  tags,
  canMerge,
  onMerge,
  onDelete,
  labels,
  className,
  buttonClassName,
  fieldClassName,
}: DetailsPanelProps) {
  const [tagDraft, setTagDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const assigneeKnown =
    !ticket.assigneeId ||
    agents.some((agent) => agent.id === ticket.assigneeId);

  const when = (value: Date | string) => <Time value={value} labels={labels} />;
  const requesterName = ticket.requester.name ?? ticket.requester.email;
  const seenAt = ticket.requesterSeenAt ? toDate(ticket.requesterSeenAt) : null;
  const seenLatest =
    seenAt !== null &&
    seenAt.getTime() >= toDate(ticket.lastMessageAt).getTime();

  return (
    <div className={cx("flex flex-col gap-4 p-4 text-sm", className)}>
      <section
        aria-label={labels.requester}
        className="flex flex-col gap-3 rounded-lg border border-border bg-background p-3"
      >
        <div className="flex items-center gap-3">
          <Avatar
            name={requesterName}
            image={ticket.requester.image}
            size="md"
          />
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">
              {requesterName ?? labels.unknownSender}
            </p>
            {ticket.requester.email &&
            ticket.requester.email !== requesterName ? (
              <p className="truncate text-xs text-muted-foreground">
                {ticket.requester.email}
              </p>
            ) : null}
          </div>
        </div>
        <ul className="flex flex-wrap gap-1.5 text-[11px]">
          <li
            className={cx(
              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5",
              ticket.verified
                ? "border-border text-muted-foreground"
                : "border-destructive/40 bg-destructive/10 text-destructive",
            )}
          >
            <Icon
              name={ticket.verified ? "shield" : "alert"}
              className="size-3 shrink-0"
            />
            {ticket.verified ? labels.verified : labels.unverifiedBadge}
          </li>
          <li className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-muted-foreground">
            <Icon
              name={ticket.channel === "email" ? "mail" : "globe"}
              className="size-3 shrink-0"
            />
            {ticket.channel === "email"
              ? labels.channelEmail
              : labels.channelWeb}
          </li>
          {ticket.visibility === "organization" ? (
            <li className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-muted-foreground">
              {labels.sharedWithOrganization}
            </li>
          ) : null}
        </ul>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Icon name="eye" className="size-3.5 shrink-0" />
          {seenLatest
            ? labels.requesterSeenLatest
            : seenAt
              ? labels.requesterSeenAt(labels.relativeTime(seenAt))
              : labels.requesterNotSeen}
        </p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted-foreground">{labels.opened}</dt>
          <dd>{when(ticket.createdAt)}</dd>
          <dt className="text-muted-foreground">{labels.lastActivity}</dt>
          <dd>{when(ticket.lastMessageAt)}</dd>
          {ticket.solvedAt ? (
            <>
              <dt className="text-muted-foreground">{labels.solvedAt}</dt>
              <dd>{when(ticket.solvedAt)}</dd>
            </>
          ) : null}
          {ticket.rating ? (
            <>
              <dt className="text-muted-foreground">{labels.rating}</dt>
              <dd
                className={cx(
                  "inline-flex items-center gap-1 font-medium",
                  ticket.rating === "good"
                    ? "text-emerald-700 dark:text-emerald-400"
                    : "text-destructive",
                )}
              >
                <Icon
                  name={ticket.rating === "good" ? "thumbsUp" : "thumbsDown"}
                  className="size-3.5 shrink-0"
                />
                {ticket.rating === "good" ? labels.ratedGood : labels.ratedBad}
              </dd>
            </>
          ) : null}
        </dl>
      </section>

      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {labels.properties}
      </h3>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">
          {labels.statusField}
        </span>
        <select
          value={ticket.status}
          onChange={(event) =>
            void update({ status: event.target.value as TicketStatus })
          }
          className={fieldClass(fieldClassName)}
        >
          {STATUSES.map((status) => (
            <option key={status} value={status}>
              {labels.status[status]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">
          {labels.priorityField}
        </span>
        <select
          value={ticket.priority ?? NONE}
          onChange={(event) =>
            void update({
              priority: (event.target.value || null) as TicketPriority | null,
            })
          }
          className={fieldClass(fieldClassName)}
        >
          <option value={NONE}>{labels.noPriority}</option>
          {PRIORITIES.map((priority) => (
            <option key={priority} value={priority}>
              {labels.priority[priority]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">
          {labels.assignee}
        </span>
        <select
          value={ticket.assigneeId ?? NONE}
          onChange={(event) =>
            void update({ assigneeId: event.target.value || null })
          }
          className={fieldClass(fieldClassName)}
        >
          <option value={NONE}>{labels.unassigned}</option>
          {assigneeKnown ? null : (
            <option value={ticket.assigneeId ?? NONE}>
              {ticket.assignee?.name ?? labels.unknownAgent}
            </option>
          )}
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
      </label>

      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">
          {labels.tags}
        </span>
        {ticket.tags.length === 0 ? (
          <span className="text-xs text-muted-foreground">{labels.noTags}</span>
        ) : (
          <ul className="flex flex-wrap gap-1">
            {ticket.tags.map((tag) => (
              <li
                key={tag}
                className="flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-xs"
              >
                {tag}
                <button
                  type="button"
                  aria-label={labels.removeTagNamed(tag)}
                  onClick={() => void update({ removeTags: [tag] })}
                  className={cx(
                    "rounded px-0.5 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    TOUCH_ICON,
                  )}
                >
                  <Icon name="x" className="size-3 shrink-0" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const tag = tagDraft.trim();
            if (!tag) return;
            setTagDraft("");
            void update({ addTags: [tag] });
          }}
        >
          <input
            type="text"
            list="support-inbox-ticket-tags"
            value={tagDraft}
            onChange={(event) => setTagDraft(event.target.value)}
            aria-label={labels.tagPlaceholder}
            placeholder={labels.tagPlaceholder}
            className={fieldClass(fieldClassName, "flex-1")}
          />
          <datalist id="support-inbox-ticket-tags">
            {tags
              .filter((tag) => !ticket.tags.includes(tag))
              .map((tag) => (
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
        </form>
      </div>

      <div className="flex flex-wrap gap-2 border-t border-border pt-4">
        {canMerge ? (
          <MergeControl
            client={client}
            source={ticket}
            labels={labels}
            buttonClassName={buttonClassName}
            fieldClassName={fieldClassName}
            onMerge={onMerge}
          />
        ) : null}
        {confirmDelete ? null : (
          <Button
            variant="danger"
            extra={buttonClassName}
            onClick={() => setConfirmDelete(true)}
          >
            <Icon name="trash" />
            {labels.deleteTicket}
          </Button>
        )}
      </div>
      {confirmDelete ? (
        <Confirm
          message={labels.confirmDelete(1)}
          confirmLabel={labels.confirmDeleteAction}
          cancelLabel={labels.cancel}
          buttonClassName={buttonClassName}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false);
            void onDelete();
          }}
        />
      ) : null}
    </div>
  );
}
