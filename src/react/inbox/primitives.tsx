import type {
  ButtonHTMLAttributes,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
} from "react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

/** Joins class names, skipping empty ones. */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";
const BUTTON_DEFAULT = "bg-background text-foreground hover:bg-accent";
const BUTTON_PRIMARY =
  "border-transparent bg-primary text-primary-foreground hover:bg-primary/90";
const BUTTON_DANGER =
  "border-transparent bg-destructive text-white hover:bg-destructive/90";

export type ButtonVariant = "default" | "primary" | "danger";

/** The class string of an action button; `extra` is the app's `buttonClassName`. */
export function buttonClass(
  variant: ButtonVariant,
  extra?: string,
  className?: string,
): string {
  return cx(
    BUTTON_BASE,
    variant === "primary"
      ? BUTTON_PRIMARY
      : variant === "danger"
        ? BUTTON_DANGER
        : BUTTON_DEFAULT,
    className,
    extra,
  );
}

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> & {
  variant?: ButtonVariant;
  /** The app's `buttonClassName`. */
  extra?: string | undefined;
};

export function Button({
  variant = "default",
  extra,
  className,
  ...props
}: ButtonProps) {
  return (
    <button
      type="button"
      className={buttonClass(variant, extra, className)}
      {...props}
    />
  );
}

/** Class string of the native selects and inputs. */
export const FIELD_CLASS =
  "min-w-0 rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * Calls `onDismiss` on Escape and on a mouse press outside `containerRef`,
 * while `active`.
 */
export function useDismiss(
  active: boolean,
  containerRef: { current: HTMLElement | null },
  onDismiss: (reason: "escape" | "outside") => void,
) {
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  useEffect(() => {
    if (!active) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        dismissRef.current("outside");
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismissRef.current("escape");
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [active, containerRef]);
}

/** Moves focus between `[data-menu-item]` elements with the arrow keys. */
export function onMenuKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const items = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>("[data-menu-item]"),
  );
  if (items.length === 0) return;
  event.preventDefault();
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next =
    event.key === "ArrowDown"
      ? items[(at + 1) % items.length]
      : items[(at <= 0 ? items.length : at) - 1];
  next?.focus();
}

/** Panel classes for pickers that hang from a toolbar row: full width on a phone, 18rem from `sm` up. */
export const PICKER_PANEL = "right-0 sm:right-auto sm:w-72";

type PopoverProps = {
  /** Visible content of the trigger. */
  trigger: ReactNode;
  /** Accessible name of the panel (and of the trigger when it has no text). */
  label: string;
  /** The app's `buttonClassName`. */
  buttonClassName?: string | undefined;
  /** Classes of the trigger itself. */
  triggerClassName?: string;
  /** Classes of the panel (`w-72` and friends). */
  panelClassName?: string;
  disabled?: boolean;
  /** Which edge the panel hangs from, and whether it opens up or down. */
  placement?: "above-start" | "below-start" | "below-end";
  /**
   * Position the panel against the nearest positioned ancestor instead of
   * the button, so it can span a toolbar and stay inside a narrow screen.
   */
  anchorToParent?: boolean;
  /** Render the panel in the flow under the button (inside a scrolling parent). */
  inline?: boolean;
  children: (api: { close: () => void }) => ReactNode;
};

/**
 * A button with a panel: closes on Escape (focus returns to the button) and
 * on an outside press, focuses the first control when it opens.
 */
export function Popover({
  trigger,
  label,
  buttonClassName,
  triggerClassName,
  panelClassName,
  disabled,
  placement = "below-start",
  anchorToParent = false,
  inline = false,
  children,
}: PopoverProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, containerRef, (reason) => {
    setOpen(false);
    if (reason === "escape") triggerRef.current?.focus();
  });

  useEffect(() => {
    if (!open) return;
    panelRef.current
      ?.querySelector<HTMLElement>("input, select, textarea, button")
      ?.focus();
  }, [open]);

  return (
    <div
      ref={containerRef}
      className={cx(
        inline ? "block w-full" : "inline-block",
        !anchorToParent && !inline && "relative",
      )}
    >
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
        className={buttonClass("default", buttonClassName, triggerClassName)}
      >
        {trigger}
      </button>
      {open ? (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label={label}
          onKeyDown={onMenuKeyDown}
          className={cx(
            "max-h-[70vh] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-md border border-border bg-popover p-2 text-popover-foreground shadow-md",
            inline && "mt-1 w-full",
            !inline && "absolute z-30",
            !inline && placement === "above-start" && "bottom-full left-0 mb-1",
            !inline && placement === "below-start" && "left-0 top-full mt-1",
            !inline && placement === "below-end" && "right-0 top-full mt-1",
            !inline && (panelClassName ?? "w-72"),
          )}
        >
          {children({ close })}
        </div>
      ) : null}
    </div>
  );
}

/** Some wire dates arrive as ISO strings. */
export function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/** True for a better-fetch / better-auth error that means "not allowed" (403). */
export function isForbidden(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { status, code } = error as { status?: unknown; code?: unknown };
  return status === 403 || code === "NOT_ALLOWED";
}

type ConfirmProps = {
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  variant?: ButtonVariant;
  buttonClassName?: string | undefined;
  className?: string;
};

/**
 * An inline confirmation (never `window.confirm`). Focus starts on Cancel;
 * Escape and an outside press cancel.
 */
export function Confirm({
  message,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  variant = "danger",
  buttonClassName,
  className,
}: ConfirmProps) {
  const ref = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useDismiss(true, ref, () => onCancel());
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);
  return (
    <div
      ref={ref}
      role="alertdialog"
      aria-label={message}
      className={cx(
        "flex flex-col gap-2 rounded-md border border-border bg-muted p-2 text-sm",
        className,
      )}
    >
      <p>{message}</p>
      <div className="flex flex-wrap gap-2">
        <button
          ref={cancelRef}
          type="button"
          onClick={onCancel}
          className={buttonClass("default", buttonClassName)}
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className={buttonClass(variant, buttonClassName)}
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}
