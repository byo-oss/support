import type { DragEvent, KeyboardEvent } from "react";
import { useEffect, useId, useRef, useState } from "react";
import type { TicketStatus } from "../../schema";
import { TOUCH_ICON, TOUCH_TARGET } from "../classes";
import type { SupportFetchClient, UseSupportAgentTicketResult } from "../hooks";
import { useSupportUpload } from "../hooks";
import { Avatar, Icon } from "../ui";
import { CannedPicker } from "./canned";
import {
  Button,
  buttonClass,
  cx,
  fieldClass,
  PICKER_PANEL,
  Popover,
} from "./primitives";
import type { InboxLabels, SupportAgent } from "./types";

/** An unsent message, kept while the agent looks at other tickets. */
export type ComposerDraft = { body: string; mode: "reply" | "note" };

/** Drafts by ticket id, owned by the inbox so they outlive a thread pane. */
export type ComposerDrafts = Map<string, ComposerDraft>;

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
  /** The ticket's status: Send and solve shows while it is open or pending. */
  status: TicketStatus;
  /** Where this ticket's unsent text lives between visits. */
  drafts?: ComposerDrafts | undefined;
  labels: InboxLabels;
  className?: string | undefined;
  buttonClassName?: string | undefined;
  fieldClassName?: string | undefined;
};

type Mode = "reply" | "note";

/** Reply/note composer: canned replies, @mentions, attachments, send and solve. */
export function Composer({
  client,
  ticketId,
  reply,
  failed,
  onFailedChange,
  agents,
  attachments,
  status,
  drafts,
  labels,
  className,
  buttonClassName,
  fieldClassName,
}: ComposerProps) {
  const [body, setBody] = useState(() => drafts?.get(ticketId)?.body ?? "");
  const [mode, setMode] = useState<Mode>(
    () => drafts?.get(ticketId)?.mode ?? "reply",
  );
  const [mentions, setMentions] = useState<Map<string, string>>(new Map());
  const [sending, setSending] = useState<false | "send" | "solve">(false);
  const [dragging, setDragging] = useState(false);

  // the draft outlives this pane: opening another ticket and coming back
  // finds the text where it was
  useEffect(() => {
    if (!drafts) return;
    if (body === "" && mode === "reply") drafts.delete(ticketId);
    else drafts.set(ticketId, { body, mode });
  }, [drafts, ticketId, body, mode]);
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

  const send = async (solve = false) => {
    if (!canSend) return;
    setSending(solve ? "solve" : "send");
    onFailedChange(false);
    // only agents whose @name is still in the text
    const mentionIds = [...mentions]
      .filter(([, name]) => text.includes(`@${name}`))
      .map(([id]) => id);
    const ok = await reply({
      body: text,
      internal: mode === "note",
      ...(solve ? { status: "solved" as const } : {}),
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

  const uploadAll = (files: File[]) => {
    if (!attachments || files.length === 0) return;
    // one at a time keeps the list in the order picked
    void (async () => {
      for (const file of files) await uploads.upload(file);
    })();
  };

  const hasFiles = (event: DragEvent) =>
    attachments && Array.from(event.dataTransfer.types).includes("Files");

  const note = mode === "note";
  const canSolve = !note && (status === "open" || status === "pending");
  return (
    // not a <form>: Enter in a picker's search box must not send the message.
    // biome-ignore lint/a11y/noStaticElementInteractions: dropping files is a shortcut for the Attach button
    <div
      className={cx(
        "relative flex shrink-0 flex-col gap-2 border-t border-border bg-background p-3",
        className,
      )}
      onDragOver={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setDragging(false);
      }}
      onDrop={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        setDragging(false);
        uploadAll(Array.from(event.dataTransfer.files));
      }}
    >
      {dragging ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-1 z-10 flex items-center justify-center gap-2 rounded-md border-2 border-dashed border-primary bg-background/90 text-sm font-medium"
        >
          <Icon name="paperclip" />
          {labels.dropFiles}
        </div>
      ) : null}
      <fieldset className="inline-flex w-fit min-w-0 items-center gap-0.5 rounded-lg border-0 bg-muted p-0.5">
        <legend className="sr-only">{labels.modeLabel}</legend>
        {(["reply", "note"] as const).map((value) => (
          <label
            key={value}
            className={cx(
              "inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-sm text-muted-foreground has-[:checked]:bg-background has-[:checked]:text-foreground has-[:checked]:shadow-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
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
            <Icon
              name={value === "reply" ? "message" : "lock"}
              className="size-3.5 shrink-0"
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
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.files);
          if (!attachments || files.length === 0) return;
          event.preventDefault();
          uploadAll(files);
        }}
        aria-label={labels.composerLabel}
        placeholder={labels.message}
        rows={4}
        className={fieldClass(
          fieldClassName,
          "min-h-24 w-full resize-y",
          note &&
            "border-dashed border-amber-500/60 bg-amber-500/5 dark:bg-amber-500/10",
        )}
      />

      {attachments && uploads.uploads.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {uploads.uploads.map((upload) => (
            <li
              key={upload.id}
              className="flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-1 text-xs"
            >
              <Icon
                name="file"
                className="size-3.5 shrink-0 text-muted-foreground"
              />
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
          trigger={
            <>
              <Icon name="at" />
              <span className="sr-only">{labels.mention}</span>
            </>
          }
          label={labels.mention}
          title={labels.mention}
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
                      "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      TOUCH_TARGET,
                    )}
                  >
                    <Avatar
                      name={agent.name}
                      image={agent.image}
                      size="xs"
                      tone="primary"
                    />
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
              title={labels.attach}
              onClick={() => fileRef.current?.click()}
            >
              <Icon name="paperclip" />
              <span className="sr-only">{labels.attach}</span>
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
                uploadAll(files);
              }}
            />
          </>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          {canSolve ? (
            <button
              type="button"
              onClick={() => void send(true)}
              disabled={!canSend}
              className={buttonClass("default", buttonClassName)}
            >
              <Icon name="check" />
              {sending === "solve" ? labels.sending : labels.sendAndSolve}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void send()}
            disabled={!canSend}
            aria-keyshortcuts="Control+Enter Meta+Enter"
            title={labels.sendHint}
            className={buttonClass("primary", buttonClassName)}
          >
            <Icon name="send" className="size-3.5 shrink-0" />
            {sending === "send" ? labels.sending : labels.send}
          </button>
        </div>
      </div>
    </div>
  );
}
