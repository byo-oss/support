import type { DragEvent, KeyboardEvent, MutableRefObject } from "react";
import { useEffect, useId, useRef, useState } from "react";
import type { TicketStatus } from "../../schema";
import { TOUCH_ICON, TOUCH_TARGET } from "../classes";
import type { SupportFetchClient, UseSupportAgentTicketResult } from "../hooks";
import { useSupportCannedReplies, useSupportUpload } from "../hooks";
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

/** What the inbox's keyboard shortcuts ask of the composer. */
export type ComposerCommands = {
  /** Switch to reply or note and put the caret in the text box. */
  focus: (mode: "reply" | "note") => void;
};

/** At most this many suggestions under the text box. */
const MAX_SUGGESTIONS = 6;

type Suggestion =
  | { kind: "canned"; id: string; title: string; body: string }
  | { kind: "mention"; agent: SupportAgent };

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
  /** Filled with the composer's commands while it is mounted. */
  commandsRef?: MutableRefObject<ComposerCommands | null> | undefined;
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
  commandsRef,
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
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  // Escape hides the suggestions until the text changes
  const [dismissed, setDismissed] = useState<string | null>(null);
  const canned = useSupportCannedReplies(client);
  const listId = useId();
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

  // the inbox's r and n shortcuts
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const resetUploads = uploads.reset;
  useEffect(() => {
    if (!commandsRef) return;
    commandsRef.current = {
      focus: (next) => {
        if (next !== modeRef.current) {
          resetUploads();
          setMode(next);
        }
        textareaRef.current?.focus();
      },
    };
    return () => {
      commandsRef.current = null;
    };
  }, [commandsRef, resetUploads]);

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

  // `/query` as the whole text suggests canned replies; `@query` just before
  // the caret suggests team members
  const slash = /^\/(\S*)$/.exec(body);
  const at = /(?:^|\s)@([^\s@]*)$/.exec(body.slice(0, caret));
  const suggestions: Suggestion[] =
    dismissed === body
      ? []
      : slash
        ? canned.cannedReplies
            .filter((reply) =>
              `${reply.title} ${reply.body}`
                .toLowerCase()
                .includes((slash[1] ?? "").toLowerCase()),
            )
            .slice(0, MAX_SUGGESTIONS)
            .map((reply) => ({
              kind: "canned" as const,
              id: reply.id,
              title: reply.title,
              body: reply.body,
            }))
        : at
          ? agents
              .filter((agent) =>
                agent.name.toLowerCase().includes((at[1] ?? "").toLowerCase()),
              )
              .slice(0, MAX_SUGGESTIONS)
              .map((agent) => ({ kind: "mention" as const, agent }))
          : [];
  const open = suggestions.length > 0;
  const activeIndex = Math.min(active, suggestions.length - 1);
  const optionId = (index: number) => `${listId}-${index}`;

  const pick = (suggestion: Suggestion) => {
    if (suggestion.kind === "canned") {
      setBody(suggestion.body);
      caretRef.current = suggestion.body.length;
      setCaret(suggestion.body.length);
    } else {
      const query = at?.[1] ?? "";
      const start = caret - query.length - 1;
      const piece = `@${suggestion.agent.name} `;
      setBody(body.slice(0, start) + piece + body.slice(caret));
      caretRef.current = start + piece.length;
      setCaret(start + piece.length);
      setMentions((prev) =>
        new Map(prev).set(suggestion.agent.id, suggestion.agent.name),
      );
    }
    setActive(0);
  };

  const text = body.trim();
  const canSend = text !== "" && !sending && !uploads.isUploading;

  const send = async (status?: TicketStatus) => {
    if (!canSend) return;
    setSending(status === "solved" ? "solve" : "send");
    onFailedChange(false);
    // only agents whose @name is still in the text
    const mentionIds = [...mentions]
      .filter(([, name]) => text.includes(`@${name}`))
      .map(([id]) => id);
    const ok = await reply({
      body: text,
      internal: mode === "note",
      ...(status ? { status } : {}),
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
    if (open && !event.ctrlKey && !event.metaKey && !event.altKey) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive(
          (activeIndex + step + suggestions.length) % suggestions.length,
        );
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const chosen = suggestions[activeIndex];
        if (chosen) {
          event.preventDefault();
          pick(chosen);
          return;
        }
      }
      if (event.key === "Escape") {
        // the inbox must not treat this Escape as its own
        event.preventDefault();
        event.stopPropagation();
        setDismissed(body);
        return;
      }
    }
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
        onChange={(event) => {
          setBody(event.target.value);
          setCaret(event.target.selectionStart ?? event.target.value.length);
          setActive(0);
        }}
        onSelect={(event) =>
          setCaret(event.currentTarget.selectionStart ?? body.length)
        }
        onKeyDown={onKeyDown}
        aria-autocomplete="list"
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? optionId(activeIndex) : undefined}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.files);
          if (!attachments || files.length === 0) return;
          event.preventDefault();
          uploadAll(files);
        }}
        aria-label={labels.composerLabel}
        placeholder={note ? labels.notePlaceholder : labels.replyPlaceholder}
        rows={4}
        className={fieldClass(
          fieldClassName,
          "min-h-24 w-full resize-y",
          note &&
            "border-dashed border-amber-500/60 bg-amber-500/5 dark:bg-amber-500/10",
        )}
      />

      {open ? (
        <div
          id={listId}
          role="listbox"
          aria-label={
            slash ? labels.cannedSuggestions : labels.mentionSuggestions
          }
          className="flex max-h-56 flex-col overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-sm"
        >
          {suggestions.map((suggestion, index) => (
            <div
              key={
                suggestion.kind === "canned"
                  ? suggestion.id
                  : suggestion.agent.id
              }
              id={optionId(index)}
              role="option"
              tabIndex={-1}
              aria-selected={index === activeIndex}
              // mousedown, not click: the text box keeps focus and its caret
              onMouseDown={(event) => {
                event.preventDefault();
                pick(suggestion);
              }}
              onMouseEnter={() => setActive(index)}
              className={cx(
                "flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm",
                TOUCH_TARGET,
                index === activeIndex && "bg-accent text-accent-foreground",
              )}
            >
              {suggestion.kind === "canned" ? (
                <>
                  <Icon
                    name="zap"
                    className="size-3.5 shrink-0 text-muted-foreground"
                  />
                  <span className="shrink-0 font-medium">
                    {suggestion.title}
                  </span>
                  <span className="min-w-0 truncate text-xs text-muted-foreground">
                    {suggestion.body}
                  </span>
                </>
              ) : (
                <>
                  <Avatar
                    name={suggestion.agent.name}
                    image={suggestion.agent.image}
                    size="xs"
                    tone="primary"
                  />
                  {suggestion.agent.name}
                </>
              )}
            </div>
          ))}
        </div>
      ) : null}

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
          canned={canned}
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
              onClick={() => void send("solved")}
              disabled={!canSend}
              className={buttonClass("default", buttonClassName)}
            >
              <Icon name="check" />
              {sending === "solve" ? labels.sending : labels.sendAndSolve}
            </button>
          ) : null}
          <div className="flex">
            <button
              type="button"
              onClick={() => void send()}
              disabled={!canSend}
              aria-keyshortcuts="Control+Enter Meta+Enter"
              title={labels.sendHint}
              className={buttonClass(
                "primary",
                buttonClassName,
                note ? undefined : "rounded-r-none",
              )}
            >
              <Icon name="send" className="size-3.5 shrink-0" />
              {sending === "send" ? labels.sending : labels.send}
            </button>
            {note ? null : (
              <Popover
                trigger={
                  <>
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="size-3.5"
                    >
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                    <span className="sr-only">{labels.sendOptions}</span>
                  </>
                }
                label={labels.sendOptions}
                title={labels.sendOptions}
                disabled={!canSend}
                variant="primary"
                buttonClassName={buttonClassName}
                triggerClassName="rounded-l-none border-l border-l-primary-foreground/20 px-1.5"
                placement="above-end"
                panelClassName="w-56"
              >
                {({ close }) => (
                  <ul className="flex flex-col">
                    {(
                      [
                        ["open", labels.sendKeepOpen],
                        ["closed", labels.sendAndClose],
                      ] as const
                    ).map(([value, text]) => (
                      <li key={value}>
                        <button
                          type="button"
                          data-menu-item
                          onClick={() => {
                            close();
                            void send(value);
                          }}
                          className={cx(
                            "w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            TOUCH_TARGET,
                          )}
                        >
                          {text}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </Popover>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
