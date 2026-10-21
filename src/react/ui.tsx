// Shared visual pieces of both components: icons, avatars, status and
// priority badges, times. Every class is a whole literal string, so
// Tailwind's `@source` scan of dist finds it. No icon library: the paths are
// drawn here (24px grid, 2px round stroke, the Lucide look).

import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { SupportLabels } from "./labels";

const PATHS = {
  back: "M15 18l-6-6 6-6",
  panel:
    "M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM15 3v18",
  paperclip:
    "M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48",
  at: "M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  zap: "M13 2L3 14h9l-1 8 10-12h-9l1-8z",
  send: "M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z",
  check: "M20 6L9 17l-5-5",
  x: "M18 6L6 18M6 6l12 12",
  mail: "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM22 6l-10 7L2 6",
  globe:
    "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z",
  lock: "M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2zM7 11V7a5 5 0 0 1 10 0v4",
  merge:
    "M18 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21V9a9 9 0 0 0 9 9",
  trash:
    "M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  thumbsUp:
    "M7 10v12M15 5.88L14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88z",
  thumbsDown:
    "M17 14V2M9 18.12L10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88z",
  message: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  inbox:
    "M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35",
  plus: "M12 5v14M5 12h14",
  shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
  alert:
    "M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01",
} as const;

export type IconName = keyof typeof PATHS;

/** A 16px stroke icon, hidden from screen readers (the control around it carries the name). */
export function Icon({
  name,
  className,
}: {
  name: IconName;
  className?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ?? "size-4 shrink-0"}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/** Up to two initials of a name or an email's local part. */
export function initials(name: string | null | undefined): string {
  const source = (name ?? "").split("@")[0]?.trim() ?? "";
  if (!source) return "?";
  const words = source.split(/[\s._-]+/).filter(Boolean);
  const first = words[0]?.[0] ?? "";
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? "") : "";
  return `${first}${last}`.toUpperCase() || "?";
}

const AVATAR_SIZE = {
  xs: "size-5 text-[9px]",
  sm: "size-7 text-[11px]",
  md: "size-9 text-xs",
} as const;

/**
 * A round picture, or initials when there is none. Decorative: the name is
 * always written next to it.
 */
export function Avatar({
  name,
  image,
  size = "sm",
  tone = "muted",
}: {
  name: string | null | undefined;
  image?: string | null | undefined;
  size?: keyof typeof AVATAR_SIZE;
  /** `primary` for staff, `muted` for customers. */
  tone?: "muted" | "primary";
}) {
  const base = `inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full font-semibold ${AVATAR_SIZE[size]}`;
  if (image) {
    return (
      <img
        src={image}
        alt=""
        aria-hidden="true"
        className={`${base} object-cover`}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`${base} ${
        tone === "primary"
          ? "bg-primary text-primary-foreground"
          : "bg-muted text-muted-foreground ring-1 ring-border"
      }`}
    >
      {initials(name)}
    </span>
  );
}

type Status = "open" | "pending" | "solved" | "closed";

const STATUS_DOT: Record<Status, string> = {
  open: "bg-sky-500",
  pending: "bg-amber-500",
  solved: "bg-emerald-500",
  closed: "bg-muted-foreground/60",
};

/** A status as a pill with a colored dot; the text is the label. */
export function StatusBadge({
  status,
  label,
}: {
  status: Status;
  label: string;
}) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-background px-2 py-0.5 text-[11px] font-medium leading-4 text-foreground">
      <span
        aria-hidden="true"
        className={`size-1.5 shrink-0 rounded-full ${STATUS_DOT[status]}`}
      />
      {label}
    </span>
  );
}

/**
 * A priority as a pill. Only high and urgent stand out; low and normal are
 * quiet text, so the queue isn't a wall of badges.
 */
export function PriorityBadge({
  priority,
  label,
}: {
  priority: "low" | "normal" | "high" | "urgent";
  label: string;
}) {
  const tone =
    priority === "urgent"
      ? "border-destructive/40 bg-destructive/10 text-destructive"
      : priority === "high"
        ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
        : "border-border text-muted-foreground";
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 ${tone}`}
    >
      {label}
    </span>
  );
}

/** A tag pill. */
export function TagPill({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex max-w-40 items-center truncate rounded-md bg-muted px-1.5 py-0.5 text-[11px] leading-4 text-muted-foreground">
      {children}
    </span>
  );
}

/** Some wire dates arrive as ISO strings. */
export function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * A relative time with the full date and time on hover, as a `<time>`
 * element. Both strings come from `labels`.
 */
export function Time({
  value,
  labels,
  className,
}: {
  value: Date | string;
  labels: Pick<SupportLabels, "relativeTime" | "absoluteTime">;
  className?: string;
}) {
  const date = asDate(value);
  const valid = !Number.isNaN(date.getTime());
  return (
    <time
      dateTime={valid ? date.toISOString() : undefined}
      title={valid ? labels.absoluteTime(date) || undefined : undefined}
      className={className}
    >
      {labels.relativeTime(date)}
    </time>
  );
}

/** Image types the server serves inline, which the components preview. */
export const PREVIEW_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** Images larger than this are listed, not previewed. */
const PREVIEW_MAX_BYTES = 5 * 1024 * 1024;

/** An attachment the components show a thumbnail of. */
export function canPreview(file: {
  contentType: string;
  size: number;
}): boolean {
  return PREVIEW_TYPES.has(file.contentType) && file.size <= PREVIEW_MAX_BYTES;
}

/**
 * A thumbnail of an image attachment, fetched as a blob (the download
 * endpoint needs the session) and shown through an object URL. An `<img>`
 * never runs script, so this is safe for any of `PREVIEW_TYPES`.
 */
export function ImagePreview({
  id,
  load,
  alt,
  onOpen,
}: {
  id: string;
  load: (id: string) => Promise<Blob | null>;
  alt: string;
  onOpen: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    let live = true;
    let made: string | null = null;
    void loadRef.current(id).then((blob) => {
      if (!live) return;
      if (!blob) {
        setFailed(true);
        return;
      }
      made = URL.createObjectURL(blob);
      setUrl(made);
    });
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [id]);
  if (failed) return null;
  if (!url) {
    return (
      <span
        aria-hidden="true"
        className="block size-24 animate-pulse rounded-md bg-muted motion-reduce:animate-none"
      />
    );
  }
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-hidden="true"
      onClick={onOpen}
      className="block overflow-hidden rounded-md border border-border"
    >
      <img
        src={url}
        alt={alt}
        className="block max-h-48 max-w-60 object-contain"
      />
    </button>
  );
}
