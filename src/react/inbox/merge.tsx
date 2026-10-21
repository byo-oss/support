import { useEffect, useState } from "react";
import { TOUCH_TARGET } from "../classes";
import type { SupportFetchClient, WireAgentTicket } from "../hooks";
import { useSupportQueue } from "../hooks";
import { Button, Confirm, cx, fieldClass, Popover } from "./primitives";
import type { InboxLabels } from "./types";

type MergeControlProps = {
  client: SupportFetchClient;
  /** The ticket being merged away. */
  source: WireAgentTicket;
  labels: InboxLabels;
  /** True when the merge went through. */
  onMerge: (target: WireAgentTicket) => Promise<boolean>;
  buttonClassName?: string | undefined;
  fieldClassName?: string | undefined;
};

/** "Merge": pick a target by ticket number or subject, confirm inline. */
export function MergeControl({
  client,
  source,
  labels,
  onMerge,
  buttonClassName,
  fieldClassName,
}: MergeControlProps) {
  return (
    <Popover
      trigger={labels.merge}
      label={labels.merge}
      buttonClassName={buttonClassName}
      inline
    >
      {({ close }) => (
        <MergePanel
          client={client}
          source={source}
          labels={labels}
          buttonClassName={buttonClassName}
          fieldClassName={fieldClassName}
          onMerge={async (target) => {
            const merged = await onMerge(target);
            if (merged) close();
          }}
        />
      )}
    </Popover>
  );
}

function MergePanel({
  client,
  source,
  labels,
  buttonClassName,
  fieldClassName,
  onMerge,
}: {
  client: SupportFetchClient;
  source: WireAgentTicket;
  labels: InboxLabels;
  buttonClassName?: string | undefined;
  fieldClassName?: string | undefined;
  onMerge: (target: WireAgentTicket) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [target, setTarget] = useState<WireAgentTicket | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(timer);
  }, [text]);

  // its own search, so a target outside the queue's current filters is found;
  // the merge itself goes through the queue's hook so the queue refreshes
  const results = useSupportQueue(client, { q, pollInterval: 0 });
  const candidates = results.tickets.filter(
    (ticket) => ticket.id !== source.id && !ticket.mergedIntoId,
  );

  return (
    <div className="flex flex-col gap-2">
      <input
        type="search"
        value={text}
        onChange={(event) => setText(event.target.value)}
        aria-label={labels.mergeSearch}
        placeholder={labels.mergeSearch}
        className={fieldClass(fieldClassName, "w-full")}
      />
      {target ? (
        <Confirm
          message={labels.confirmMerge(source.number, target.number)}
          confirmLabel={labels.confirmMergeAction}
          cancelLabel={labels.cancel}
          variant="primary"
          buttonClassName={buttonClassName}
          onCancel={() => setTarget(null)}
          onConfirm={() => void onMerge(target)}
        />
      ) : null}
      {candidates.length === 0 ? (
        <p className="px-1 py-2 text-sm text-muted-foreground">
          {results.isLoading ? labels.loading : labels.mergeEmpty}
        </p>
      ) : (
        <ul className="max-h-60 overflow-y-auto">
          {candidates.map((ticket) => (
            <li key={ticket.id}>
              <button
                type="button"
                data-menu-item
                aria-label={`${labels.mergeInto(ticket.number)}: ${ticket.subject}`}
                onClick={() => setTarget(ticket)}
                className={cx(
                  "flex w-full items-baseline gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  TOUCH_TARGET,
                )}
              >
                <span className="shrink-0 text-xs text-muted-foreground">
                  {labels.ticketNumber(ticket.number)}
                </span>
                <span className="truncate">{ticket.subject}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div>
        <Button extra={buttonClassName} onClick={() => setTarget(null)}>
          {labels.cancel}
        </Button>
      </div>
    </div>
  );
}
