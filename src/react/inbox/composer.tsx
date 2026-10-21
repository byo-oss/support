import type { KeyboardEvent } from "react";
import { useEffect, useId, useRef, useState } from "react";
import type { TicketStatus } from "../../schema";
import { TOUCH_ICON, TOUCH_TARGET } from "../classes";
import type { SupportFetchClient, UseSupportAgentTicketResult } from "../hooks";
import { useSupportUpload } from "../hooks";
import { CannedPicker } from "./canned";
import {
  Button,
  buttonClass,
  cx,
  fieldClass,
  PICKER_PANEL,
  Popover,
} from "./primitives";
import { STATUSES } from "./queue";
import type { InboxLabels, SupportAgent } from "./types";

type ComposerProps = {
  client: SupportFetchClient;
  /** The ticket being answered (its resolved id). */
  ticketId: string;
  reply: UseSupportAgentTicketResult["reply"];
  /** The last send failed (shown by the composer, not as a thread error). */
  failed: boolean;
  onFailedChange: (failed: boolean) => void;
  agents: SupportAgent[];
  /** `features.attachments` from the server. */
  attachments: boolean;
  labels: InboxLabels;
  className?: string | undefined;
  buttonClassName?: string | undefined;
  fieldClassName?: string | undefined;
};

type Mode = "reply" | "note";

/** Reply/note composer: canned replies, @mentions, attachments, status on send. */
export function Composer({
  client,
  ticketId,
  reply,
  failed,
  onFailedChange,
  agents,
  attachments,
  labels,
  className,
  buttonClassName,
  fieldClassName,
}: ComposerProps) {
  const [body, setBody] = useState("");
  const [mode, setMode] = useState<Mode>("reply");
  const [statusOnSend, setStatusOnSend] = useState<TicketStatus | "">("");
  const [mentions, setMentions] = useState<Map<string, string>>(new Map());
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const caretRef = useRef<number | null>(null);
  const modeName = useId();

  // an upload's `internal` must match the message kind, so a note and a
  // reply never share pending uploads
  const uploads = useSupportUpload(client, {
    ticketId,
    agent: true,
    internal: mode === "note",
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: places the caret after each text change
  useEffect(() => {
    const caret = caretRef.current;
    const el = textareaRef.current;
    if (caret === null || !el) return;
    caretRef.current = null;
    el.focus();
    el.setSelectionRange(caret, caret);
  }, [body]);

  const changeMode = (next: Mode) => {
    if (next === mode) return;
    uploads.reset();
    setMode(next);
  };

  const insert = (text: string, spaced: boolean) => {
    const el = textareaRef.current;
    const start = el?.selectionStart ?? body.length;
    const end = el?.selectionEnd ?? start;
    const before = body.slice(0, start);
    const lead = spaced && before !== "" && !/\s$/.test(before) ? " " : "";
    const piece = `${lead}${text}`;
    setBody(before + piece + body.slice(end));
    caretRef.current = start + piece.length;
  };

  const mention = (agent: SupportAgent) => {
    insert(`@${agent.name} `, true);
    setMentions((prev) => new Map(prev).set(agent.id, agent.name));
  };

  const text = body.trim();
  const canSend = text !== "" && !sending && !uploads.isUploading;

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    onFailedChange(false);
    // only agents whose @name is still in the text
    const mentionIds = [...mentions]
      .filter(([, name]) => text.includes(`@${name}`))
      .map(([id]) => id);
    const ok = await reply({
      body: text,
      internal: mode === "note",
      ...(statusOnSend ? { status: statusOnSend } : {}),
      ...(mentionIds.length > 0 ? { mentions: mentionIds } : {}),
      ...(uploads.uploads.length > 0
        ? { attachmentIds: uploads.uploads.map((upload) => upload.id) }
        : {}),
    });
    setSending(false);
    if (ok) {
      setBody("");
      setMentions(new Map());
      uploads.reset();
    } else {
      onFailedChange(true);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter writes a new line; Ctrl/Cmd+Enter sends
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void send();
    }
  };

  const note = mode === "note";
  return (
    // not a <form>: Enter in a picker's search box must not send the message
    <div
      className={cx(
        "flex flex-col gap-2 border-t border-border bg-background p-3",
        className,
      )}
    >
      <fieldset className="flex min-w-0 flex-wrap items-center gap-2 border-0 p-0">
        <legend className="sr-only">{labels.modeLabel}</legend>
        {(["reply", "note"] as const).map((value) => (
          <label
            key={value}
            className={cx(
              "inline-flex cursor-pointer items-center rounded-md border border-border px-2.5 py-1 text-sm has-[:checked]:bg-primary has-[:checked]:text-primary-foreground has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
              TOUCH_TARGET,
              buttonClassName,
            )}
          >
            <input
              type="radio"
              name={modeName}
              value={value}
              checked={mode === value}
              onChange={() => changeMode(value)}
              className="sr-only"
            />
            {value === "reply" ? labels.reply : labels.internalNote}
          </label>
        ))}
      </fieldset>

      <textarea
        ref={textareaRef}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={onKeyDown}
        aria-label={labels.composerLabel}
        placeholder={labels.message}
        rows={4}
        className={fieldClass(
          fieldClassName,
          "w-full resize-y",
          note && "border-dashed bg-accent/40",
        )}
      />

      {attachments && uploads.uploads.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {uploads.uploads.map((upload) => (
            <li
              key={upload.id}
              className="flex items-center gap-1 rounded bg-muted px-2 py-1 text-xs"
            >
              <span className="max-w-40 truncate">{upload.filename}</span>
              <span className="text-muted-foreground">
                {labels.fileSize(upload.size)}
              </span>
              <button
                type="button"
                aria-label={labels.removeAttachment(upload.filename)}
                onClick={() => uploads.remove(upload.id)}
                className={cx(
                  "rounded px-1 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  TOUCH_ICON,
                )}
              >
                <span aria-hidden>×</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {attachments && uploads.isUploading ? (
        <p role="status" className="text-xs text-muted-foreground">
          {labels.uploading}
        </p>
      ) : null}
      {attachments && uploads.error ? (
        <p role="alert" className="text-xs text-destructive">
          {labels.uploadFailed}
        </p>
      ) : null}
      {failed ? (
        <p role="alert" className="text-xs text-destructive">
          {labels.sendFailed}
        </p>
      ) : null}

      <div className="relative flex flex-wrap items-center gap-2">
        <CannedPicker
          client={client}
          labels={labels}
          buttonClassName={buttonClassName}
          fieldClassName={fieldClassName}
          onInsert={(value) => insert(value, false)}
        />
        <Popover
          trigger={labels.mention}
          label={labels.mention}
          buttonClassName={buttonClassName}
          placement="above-start"
          anchorToParent
          panelClassName={PICKER_PANEL}
          disabled={agents.length === 0}
        >
          {({ close }) => (
            <ul className="max-h-60 overflow-y-auto">
              {agents.map((agent) => (
                <li key={agent.id}>
                  <button
                    type="button"
                    data-menu-item
                    aria-label={labels.mentionAgent(agent.name)}
                    onClick={() => {
                      mention(agent);
                      close();
                    }}
                    className={cx(
                      "w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      TOUCH_TARGET,
                    )}
                  >
                    {agent.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Popover>
        {attachments ? (
          <>
            <Button
              extra={buttonClassName}
              onClick={() => fileRef.current?.click()}
            >
              {labels.attach}
            </Button>
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              data-testid="support-inbox-file"
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                event.target.value = "";
                // one at a time keeps the list in the order picked
                void (async () => {
                  for (const file of files) await uploads.upload(file);
                })();
              }}
            />
          </>
        ) : null}
        <select
          aria-label={labels.statusOnSend}
          value={statusOnSend}
          onChange={(event) =>
            setStatusOnSend(event.target.value as TicketStatus | "")
          }
          className={fieldClass(fieldClassName)}
        >
          <option value="">{labels.statusOnSendDefault}</option>
          {STATUSES.map((status) => (
            <option key={status} value={status}>
              {labels.status[status]}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void send()}
          disabled={!canSend}
          aria-keyshortcuts="Control+Enter Meta+Enter"
          className={buttonClass("primary", buttonClassName, "ml-auto")}
        >
          {sending ? labels.sending : labels.send}
        </button>
      </div>
    </div>
  );
}
