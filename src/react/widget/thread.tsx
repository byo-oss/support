import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  type SupportFetchClient,
  useSupportTicket,
  useSupportUpload,
  type WireCustomerAttachment,
  type WireCustomerMessage,
  type WireUploadedAttachment,
} from "../hooks";
import {
  buttonBase,
  canActAsRequester,
  cn,
  fieldBase,
  focusRing,
  MAX_ATTACHMENTS,
  primaryButton,
  type WidgetLabels,
} from "./util";

export type ThreadViewProps = {
  client: SupportFetchClient;
  ticketId: string;
  labels: WidgetLabels;
  /** From the ticket list response (`features.attachments`). */
  attachmentsEnabled: boolean;
  pollInterval: number | undefined;
  /** Same-origin links in a message body go through this. */
  onNavigate: (href: string) => void;
  renderMessage:
    | ((message: WireCustomerMessage, fallback: ReactNode) => ReactNode)
    | undefined;
  /** Called after something changed server-side, so the list can refresh. */
  onChanged: () => void;
  onBack: () => void;
  className: string | undefined;
  messageClassName: string | undefined;
  composerClassName: string | undefined;
};

/** Revoke a blob URL a minute after it was handed to the browser. */
const REVOKE_AFTER_MS = 60_000;

export function ThreadView({
  client,
  ticketId,
  labels,
  attachmentsEnabled,
  pollInterval,
  onNavigate,
  renderMessage,
  onChanged,
  onBack,
  className,
  messageClassName,
  composerClassName,
}: ThreadViewProps) {
  const thread = useSupportTicket(
    client,
    ticketId,
    pollInterval === undefined ? {} : { pollInterval },
  );
  const { ticket, markSeen } = thread;
  // after a merge the server answers with the target ticket; uploads follow it
  const uploads = useSupportUpload(client, {
    ticketId: ticket?.id ?? ticketId,
  });

  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  // opening an unread ticket marks it seen (requesters only: `unread` is
  // never true for a teammate, so they never hit the requester-only endpoint)
  const unread = ticket?.unread === true;
  const seenFor = useRef<string | null>(null);
  const ticketKey = ticket
    ? `${ticket.id}:${String(ticket.lastMessageAt)}`
    : null;
  useEffect(() => {
    if (!unread || ticketKey === null || seenFor.current === ticketKey) return;
    seenFor.current = ticketKey;
    void markSeen().then(onChanged);
  }, [unread, ticketKey, markSeen, onChanged]);

  const [attachmentError, setAttachmentError] = useState(false);
  const [actionError, setActionError] = useState(false);

  const run = async (action: Promise<boolean>) => {
    const done = await action;
    setActionError(!done);
    if (done) onChanged();
    return done;
  };

  const present = async (
    attachment: WireCustomerAttachment,
    mode: "open" | "download",
  ) => {
    const blob = await thread.openAttachment(attachment.id);
    setAttachmentError(blob === null);
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    if (mode === "open") {
      window.open(url, "_blank", "noopener");
    } else {
      const link = document.createElement("a");
      link.href = url;
      link.download = attachment.filename;
      link.rel = "noopener";
      document.body.append(link);
      link.click();
      link.remove();
    }
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
  };

  const byMessage = new Map<string, WireCustomerAttachment[]>();
  for (const attachment of thread.attachments) {
    if (!attachment.messageId) continue;
    const list = byMessage.get(attachment.messageId) ?? [];
    list.push(attachment);
    byMessage.set(attachment.messageId, list);
  }

  const status = ticket?.status;
  const canSolve = status === "open" || status === "pending";
  const canReopen = status === "solved";
  const requester = ticket ? canActAsRequester(ticket) : false;
  const showError = thread.error !== null || actionError;

  return (
    <section className={cn("flex min-h-0 flex-col", className)}>
      <header className="flex items-start gap-2 border-b border-border px-3 py-2">
        <button
          type="button"
          onClick={onBack}
          className={cn(buttonBase, "shrink-0")}
        >
          {labels.back}
        </button>
        <div className="min-w-0 flex-1">
          <h2
            ref={headingRef}
            tabIndex={-1}
            className="break-words text-sm font-medium focus:outline-none"
          >
            {ticket ? (
              <>
                <span className="text-muted-foreground">
                  {labels.ticketNumber(ticket.number)}
                </span>{" "}
                {ticket.subject}
              </>
            ) : (
              labels.support
            )}
          </h2>
          {ticket ? (
            <span className="inline-block rounded-full bg-accent px-2 py-0.5 text-xs text-accent-foreground">
              {labels.status[ticket.status]}
            </span>
          ) : null}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {thread.isLoading && !ticket ? (
          <p
            className="px-3 py-6 text-center text-sm text-muted-foreground"
            role="status"
          >
            {labels.loading}
          </p>
        ) : (
          <ul className="flex flex-col gap-2 p-3">
            {thread.messages.map((message) => {
              const fallback = (
                <MessageBody
                  message={message}
                  attachments={byMessage.get(message.id) ?? []}
                  labels={labels}
                  onPresent={present}
                  onNavigate={onNavigate}
                />
              );
              return (
                <li
                  key={message.id}
                  className={cn(
                    "min-w-0 rounded-md border border-border p-2 text-sm",
                    message.authorType === "agent"
                      ? "bg-accent text-accent-foreground"
                      : "bg-background text-foreground",
                    messageClassName,
                  )}
                >
                  {renderMessage ? renderMessage(message, fallback) : fallback}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {showError ? (
        <p role="alert" className="px-3 pb-2 text-sm text-destructive">
          {labels.somethingWrong}
        </p>
      ) : null}
      {attachmentError ? (
        <p role="alert" className="px-3 pb-2 text-sm text-destructive">
          {labels.attachmentFailed}
        </p>
      ) : null}

      {ticket && requester ? (
        <div className="flex flex-col gap-2 border-t border-border px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            {canSolve ? (
              <button
                type="button"
                className={buttonBase}
                onClick={() => void run(thread.update({ status: "solved" }))}
              >
                {labels.solve}
              </button>
            ) : null}
            {canReopen ? (
              <button
                type="button"
                className={buttonBase}
                onClick={() => void run(thread.update({ status: "open" }))}
              >
                {labels.reopen}
              </button>
            ) : null}
          </div>
          <fieldset className="m-0 flex min-w-0 flex-wrap items-center gap-2 border-0 p-0">
            <legend className="float-left mr-2 p-0 text-sm text-muted-foreground">
              {labels.ratePrompt}
            </legend>
            {(["good", "bad"] as const).map((rating) => (
              <button
                key={rating}
                type="button"
                aria-pressed={ticket.rating === rating}
                className={cn(
                  buttonBase,
                  ticket.rating === rating &&
                    "bg-accent text-accent-foreground",
                )}
                onClick={() => {
                  if (ticket.rating !== rating)
                    void run(thread.update({ rating }));
                }}
              >
                {rating === "good" ? labels.rateGood : labels.rateBad}
              </button>
            ))}
          </fieldset>
          {ticket.organizationId ? (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={ticket.visibility === "organization"}
                onChange={(event) =>
                  void run(
                    thread.update({
                      visibility: event.target.checked
                        ? "organization"
                        : "private",
                    }),
                  )
                }
                className={focusRing}
              />
              {labels.shareWithOrganization}
            </label>
          ) : null}
        </div>
      ) : null}

      {ticket && status !== "closed" ? (
        <Composer
          labels={labels}
          attachmentsEnabled={attachmentsEnabled}
          uploads={uploads}
          className={composerClassName}
          onSend={async (body, attachmentIds) => {
            const done = await run(
              thread.reply({
                body,
                ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
              }),
            );
            if (done) uploads.reset();
            return done;
          }}
        />
      ) : null}
      {ticket && status === "closed" ? (
        <p className="border-t border-border px-3 py-3 text-sm text-muted-foreground">
          {labels.ticketClosed}
        </p>
      ) : null}
    </section>
  );
}

function MessageBody({
  message,
  attachments,
  labels,
  onPresent,
  onNavigate,
}: {
  message: WireCustomerMessage;
  attachments: WireCustomerAttachment[];
  labels: WidgetLabels;
  onNavigate: (href: string) => void;
  onPresent: (
    attachment: WireCustomerAttachment,
    mode: "open" | "download",
  ) => Promise<void>;
}) {
  if (message.kind === "event") {
    const text = eventText(message, labels);
    return text ? (
      <p className="text-xs text-muted-foreground">
        {text} · {labels.relativeTime(message.createdAt)}
      </p>
    ) : null;
  }
  const name =
    message.author?.name ??
    (message.authorType === "agent"
      ? labels.supportTeam
      : labels.unknownAuthor);
  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-x-2">
        <span className="break-words font-medium">{name}</span>
        <span className="text-xs text-muted-foreground">
          {labels.relativeTime(message.createdAt)}
        </span>
      </div>
      <p className="mt-1 whitespace-pre-wrap break-words">
        {renderBody(message.body, onNavigate)}
      </p>
      {attachments.length > 0 ? (
        <ul
          aria-label={labels.attachments}
          className="mt-2 flex flex-col gap-1"
        >
          {attachments.map((attachment) => (
            <li
              key={attachment.id}
              className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"
            >
              <span className="min-w-0 break-all">{attachment.filename}</span>
              <span className="text-muted-foreground">
                {labels.fileSize(attachment.size)}
              </span>
              <button
                type="button"
                onClick={() => void onPresent(attachment, "open")}
                className={cn("rounded px-1 underline", focusRing)}
              >
                {labels.openAttachment(attachment.filename)}
              </button>
              <button
                type="button"
                onClick={() => void onPresent(attachment, "download")}
                className={cn("rounded px-1 underline", focusRing)}
              >
                {labels.downloadAttachment(attachment.filename)}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/** Links in a body; same-origin ones route through `onNavigate`. */
function renderBody(
  text: string,
  onNavigate: (href: string) => void,
): ReactNode {
  const linkClick = (event: MouseEvent<HTMLAnchorElement>, href: string) => {
    try {
      const url = new URL(href, window.location.href);
      if (url.origin !== window.location.origin) return;
      event.preventDefault();
      onNavigate(`${url.pathname}${url.search}${url.hash}`);
    } catch {
      // not a URL we can route; the browser handles it
    }
  };
  return text.split(/(https?:\/\/[^\s<>"']+)/g).map((part, index) =>
    index % 2 === 1 ? (
      <a
        // biome-ignore lint/suspicious/noArrayIndexKey: parts have no identity
        key={index}
        href={part}
        target="_blank"
        rel="noopener noreferrer nofollow"
        onClick={(event) => linkClick(event, part)}
        className="underline"
      >
        {part}
      </a>
    ) : (
      part
    ),
  );
}

function eventText(
  message: WireCustomerMessage,
  labels: WidgetLabels,
): string | null {
  const data = message.data;
  if (!data) return null;
  if (data.type === "status") {
    const name = (value: string | null | undefined) =>
      (value && labels.status[value as keyof WidgetLabels["status"]]) ||
      value ||
      "";
    return labels.statusChanged(name(data.from), name(data.to));
  }
  if (data.type === "merged") return labels.ticketMerged;
  return null;
}

type UploadState = ReturnType<typeof useSupportUpload>;

function Composer({
  labels,
  attachmentsEnabled,
  uploads,
  className,
  onSend,
}: {
  labels: WidgetLabels;
  attachmentsEnabled: boolean;
  uploads: UploadState;
  className: string | undefined;
  onSend: (body: string, attachmentIds: string[]) => Promise<boolean>;
}) {
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const fieldId = useId();

  const submit = async () => {
    const text = body.trim();
    if (!text || sending || uploads.isUploading) return;
    setSending(true);
    try {
      const done = await onSend(
        text,
        uploads.uploads.map((attachment) => attachment.id),
      );
      if (done) setBody("");
    } finally {
      setSending(false);
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void submit();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void submit();
    }
  };
  const onFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.target;
    const files = Array.from(input.files ?? []);
    input.value = "";
    for (const file of files) await uploads.upload(file);
  };

  return (
    <form
      onSubmit={onSubmit}
      className={cn(
        "flex flex-col gap-2 border-t border-border p-3",
        className,
      )}
    >
      <label htmlFor={fieldId} className="sr-only">
        {labels.reply}
      </label>
      <textarea
        id={fieldId}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={labels.replyPlaceholder}
        rows={3}
        maxLength={50_000}
        className={cn(fieldBase, "resize-y")}
      />
      {attachmentsEnabled ? (
        <>
          {uploads.uploads.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {uploads.uploads.map((attachment: WireUploadedAttachment) => (
                <li
                  key={attachment.id}
                  className="flex items-center justify-between gap-2 text-xs"
                >
                  <span className="min-w-0 break-all">
                    {attachment.filename}{" "}
                    <span className="text-muted-foreground">
                      {labels.fileSize(attachment.size)}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => uploads.remove(attachment.id)}
                    className={cn("shrink-0 rounded px-1 underline", focusRing)}
                  >
                    {labels.removeAttachment(attachment.filename)}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {uploads.isUploading ? (
            <p role="status" className="text-xs text-muted-foreground">
              {labels.uploading}
            </p>
          ) : null}
          {uploads.error ? (
            <p role="alert" className="text-xs text-destructive">
              {labels.uploadFailed}
            </p>
          ) : null}
        </>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        {attachmentsEnabled ? (
          <label
            className={cn(
              buttonBase,
              "cursor-pointer focus-within:ring-2 focus-within:ring-ring",
              uploads.uploads.length >= MAX_ATTACHMENTS &&
                "pointer-events-none opacity-50",
            )}
          >
            <input
              type="file"
              multiple
              className="sr-only"
              disabled={uploads.uploads.length >= MAX_ATTACHMENTS}
              onChange={(event) => void onFiles(event)}
            />
            {labels.attach}
          </label>
        ) : (
          <span />
        )}
        <button
          type="submit"
          disabled={!body.trim() || sending || uploads.isUploading}
          className={primaryButton}
        >
          {labels.send}
        </button>
      </div>
    </form>
  );
}
