import { useState } from "react";
import type { TicketPriority, TicketStatus } from "../../schema";
import { TOUCH_ICON } from "../classes";
import type {
  SupportFetchClient,
  UseSupportAgentTicketResult,
  WireAgentTicket,
} from "../hooks";
import { MergeControl } from "./merge";
import { Button, buttonClass, Confirm, cx, fieldClass } from "./primitives";
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

  return (
    <div className={cx("flex flex-col gap-3 p-3 text-sm", className)}>
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
                className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs"
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
                  <span aria-hidden>×</span>
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

      <div className="flex flex-wrap gap-2">
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
