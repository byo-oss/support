import { useEffect, useRef, useState } from "react";
import { TOUCH_ICON, TOUCH_TARGET } from "../classes";
import type { SupportFetchClient, WireCannedReply } from "../hooks";
import { useSupportCannedReplies } from "../hooks";
import { Icon } from "../ui";
import {
  Button,
  buttonClass,
  cx,
  fieldClass,
  isForbidden,
  PICKER_PANEL,
  Popover,
} from "./primitives";
import type { InboxLabels } from "./types";

type CannedPickerProps = {
  client: SupportFetchClient;
  labels: InboxLabels;
  onInsert: (text: string) => void;
  buttonClassName?: string | undefined;
  fieldClassName?: string | undefined;
};

/**
 * Canned-reply picker. Management (create, edit, delete) shows only when the
 * client exposes it, and goes away once the server answers 403 to it. The
 * whole picker goes away when even listing is forbidden.
 */
export function CannedPicker({
  client,
  labels,
  onInsert,
  buttonClassName,
  fieldClassName,
}: CannedPickerProps) {
  const canned = useSupportCannedReplies(client);
  const [hidden, setHidden] = useState(false);
  const [manageForbidden, setManageForbidden] = useState(false);
  const managing = useRef(false);

  useEffect(() => {
    if (!isForbidden(canned.error)) return;
    if (managing.current) setManageForbidden(true);
    else setHidden(true);
  }, [canned.error]);

  if (hidden) return null;
  const canManage =
    !manageForbidden &&
    typeof client.support.agent.canned.save === "function" &&
    typeof client.support.agent.canned.delete === "function";

  return (
    <Popover
      trigger={
        <>
          <Icon name="zap" />
          <span className="sr-only">{labels.cannedReplies}</span>
        </>
      }
      label={labels.cannedReplies}
      title={labels.cannedReplies}
      buttonClassName={buttonClassName}
      placement="above-start"
      anchorToParent
      panelClassName={PICKER_PANEL}
    >
      {({ close }) => (
        <CannedPanel
          replies={canned.cannedReplies}
          labels={labels}
          canManage={canManage}
          buttonClassName={buttonClassName}
          fieldClassName={fieldClassName}
          onInsert={(text) => {
            onInsert(text);
            close();
          }}
          onSave={async (input) => {
            managing.current = true;
            return (await canned.save(input)) !== null;
          }}
          onRemove={async (id) => {
            managing.current = true;
            return canned.remove(id);
          }}
        />
      )}
    </Popover>
  );
}

function CannedPanel({
  replies,
  labels,
  canManage,
  buttonClassName,
  fieldClassName,
  onInsert,
  onSave,
  onRemove,
}: {
  replies: WireCannedReply[];
  labels: InboxLabels;
  canManage: boolean;
  buttonClassName?: string | undefined;
  fieldClassName?: string | undefined;
  onInsert: (text: string) => void;
  onSave: (input: {
    id?: string;
    title: string;
    body: string;
  }) => Promise<boolean>;
  onRemove: (id: string) => Promise<boolean>;
}) {
  const [filter, setFilter] = useState("");
  const [managing, setManaging] = useState(false);
  const [editId, setEditId] = useState<string | undefined>();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? replies.filter(
        (reply) =>
          reply.title.toLowerCase().includes(needle) ||
          reply.body.toLowerCase().includes(needle),
      )
    : replies;
  const manageMode = managing && canManage;

  const resetForm = () => {
    setEditId(undefined);
    setTitle("");
    setBody("");
  };

  return (
    <div className="flex flex-col gap-2">
      <input
        type="search"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        aria-label={labels.cannedSearch}
        placeholder={labels.cannedSearch}
        className={fieldClass(fieldClassName, "w-full")}
      />
      {shown.length === 0 ? (
        <p className="px-1 py-2 text-sm text-muted-foreground">
          {labels.cannedEmpty}
        </p>
      ) : (
        <ul className="max-h-60 overflow-y-auto">
          {shown.map((reply) => (
            <li key={reply.id} className="flex items-start gap-1">
              <button
                type="button"
                data-menu-item
                onClick={() => {
                  if (manageMode) {
                    setEditId(reply.id);
                    setTitle(reply.title);
                    setBody(reply.body);
                  } else {
                    onInsert(reply.body);
                  }
                }}
                className={cx(
                  "min-w-0 flex-1 rounded px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  TOUCH_TARGET,
                )}
              >
                <span className="block truncate font-medium">
                  {reply.title}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {reply.body}
                </span>
              </button>
              {manageMode ? (
                <button
                  type="button"
                  data-menu-item
                  aria-label={labels.cannedDelete(reply.title)}
                  onClick={() => {
                    if (editId === reply.id) resetForm();
                    void onRemove(reply.id);
                  }}
                  className={cx(
                    "rounded px-2 py-1.5 text-sm text-destructive hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    TOUCH_ICON,
                  )}
                >
                  <span aria-hidden>×</span>
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {manageMode ? (
        <form
          className="flex flex-col gap-2 border-t border-border pt-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!title.trim() || !body.trim()) return;
            const input = { title: title.trim(), body, id: editId };
            void onSave(
              editId === undefined ? { title: input.title, body } : input,
            ).then((saved) => {
              if (saved) resetForm();
            });
          }}
        >
          <input
            type="text"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            aria-label={labels.cannedTitle}
            placeholder={labels.cannedTitle}
            className={fieldClass(fieldClassName, "w-full")}
          />
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            aria-label={labels.cannedBody}
            placeholder={labels.cannedBody}
            rows={3}
            className={fieldClass(fieldClassName, "w-full")}
          />
          <button
            type="submit"
            disabled={!title.trim() || !body.trim()}
            className={buttonClass("primary", buttonClassName)}
          >
            {labels.cannedSave}
          </button>
        </form>
      ) : null}
      {canManage ? (
        <div>
          <Button
            extra={buttonClassName}
            aria-pressed={managing}
            onClick={() => {
              setManaging((value) => !value);
              resetForm();
            }}
          >
            {labels.cannedManage}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
