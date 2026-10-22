import type { MutableRefObject } from "react";
import { useEffect, useRef, useState } from "react";
import { TOUCH_TARGET } from "../classes";
import { Icon } from "../ui";
import type { ComposerCommands } from "./composer";
import { Button, useDismiss } from "./primitives";
import type { ThreadActions } from "./thread";
import type { InboxLabels } from "./types";

const STORAGE_KEY = "byo-support.shortcuts";

/** Single-key shortcuts on or off, remembered in this browser. */
export function useShortcutsSetting(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => {
    try {
      return globalThis.localStorage?.getItem(STORAGE_KEY) !== "off";
    } catch {
      return true;
    }
  });
  const set = (next: boolean) => {
    setOn(next);
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, next ? "on" : "off");
    } catch {
      // private mode: the choice lasts until reload
    }
  };
  return [on, set];
}

/** Elements whose keys are text, never shortcuts. */
const TYPING =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

/**
 * The inbox's keys. They act only while focus is in the inbox or on the
 * page itself (nothing focused), never in a field, a dialog or with a
 * modifier held, so they stay out of the app's own shortcuts.
 */
export function useInboxShortcuts({
  rootRef,
  enabled,
  onHelp,
  commandsRef,
  actionsRef,
}: {
  rootRef: MutableRefObject<HTMLElement | null>;
  enabled: boolean;
  onHelp: () => void;
  commandsRef: MutableRefObject<ComposerCommands | null>;
  actionsRef: MutableRefObject<ThreadActions | null>;
}) {
  const latest = useRef({ enabled, onHelp });
  latest.current = { enabled, onHelp };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey) return;
      if (event.altKey || event.isComposing) return;
      const root = rootRef.current;
      const target = event.target as Element | null;
      if (!root || !target) return;
      const inside = root.contains(target) || target === document.body;
      if (
        !inside ||
        target.closest(TYPING) ||
        target.closest('[role="dialog"]')
      )
        return;
      if (!latest.current.enabled) return;
      const rows = Array.from(
        root.querySelectorAll<HTMLElement>("[data-ticket-id]"),
      );
      const act = (fn: () => void) => {
        event.preventDefault();
        fn();
      };
      switch (event.key) {
        case "?":
          return act(latest.current.onHelp);
        case "j":
        case "k": {
          if (rows.length === 0) return;
          return act(() => {
            const focused = rows.indexOf(document.activeElement as HTMLElement);
            const current =
              focused >= 0
                ? focused
                : rows.findIndex((row) => row.getAttribute("aria-current"));
            const next =
              current < 0
                ? 0
                : Math.min(
                    rows.length - 1,
                    Math.max(0, current + (event.key === "j" ? 1 : -1)),
                  );
            rows[next]?.focus();
            rows[next]?.scrollIntoView?.({ block: "nearest" });
          });
        }
        case "/": {
          const search = root.querySelector<HTMLInputElement>(
            'input[type="search"]',
          );
          if (!search) return;
          return act(() => search.focus());
        }
        case "r":
        case "n": {
          const commands = commandsRef.current;
          if (!commands) return;
          return act(() =>
            commands.focus(event.key === "r" ? "reply" : "note"),
          );
        }
        case "e": {
          const actions = actionsRef.current;
          if (!actions) return;
          return act(() => actions.solve());
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [rootRef, commandsRef, actionsRef]);
}

/** The `?` sheet: every shortcut, and the switch that turns single keys off. */
export function ShortcutsDialog({
  labels,
  enabled,
  onEnabledChange,
  onClose,
  buttonClassName,
}: {
  labels: InboxLabels;
  enabled: boolean;
  onEnabledChange: (on: boolean) => void;
  onClose: () => void;
  buttonClassName?: string | undefined;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useDismiss(true, ref, () => onClose());
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => before?.focus?.();
  }, []);
  const rows: [string, string][] = [
    ["j", labels.shortcutNext],
    ["k", labels.shortcutPrevious],
    ["Enter", labels.shortcutOpen],
    ["/", labels.shortcutSearch],
    ["r", labels.shortcutReply],
    ["n", labels.shortcutNote],
    ["e", labels.shortcutSolve],
    ["?", labels.shortcutHelp],
  ];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/60 p-4 backdrop-blur-sm">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={labels.shortcuts}
        className="flex max-h-[85vh] w-full max-w-sm flex-col gap-4 overflow-y-auto rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-xl"
      >
        <div className="flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Icon name="keyboard" />
            {labels.shortcuts}
          </h2>
          <button
            ref={closeRef}
            type="button"
            aria-label={labels.close}
            onClick={onClose}
            className={`inline-flex items-center justify-center rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${TOUCH_TARGET}`}
          >
            <Icon name="x" />
          </button>
        </div>
        <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-sm">
          {rows.map(([key, text]) => (
            <div key={key} className="contents">
              <dt>
                <kbd className="inline-flex min-w-6 items-center justify-center rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs">
                  {key}
                </kbd>
              </dt>
              <dd className={enabled ? undefined : "text-muted-foreground"}>
                {text}
              </dd>
            </div>
          ))}
          <dt>
            <kbd className="inline-flex items-center justify-center rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs">
              {labels.sendKeys}
            </kbd>
          </dt>
          <dd>{labels.shortcutSend}</dd>
        </dl>
        <label className={`flex items-start gap-2 text-sm ${TOUCH_TARGET}`}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => onEnabledChange(event.target.checked)}
            className="mt-0.5"
          />
          <span className="flex flex-col gap-0.5">
            <span className="font-medium">{labels.shortcutsToggle}</span>
            <span className="text-xs text-muted-foreground">
              {labels.shortcutsToggleHint}
            </span>
          </span>
        </label>
        <div className="flex justify-end">
          <Button extra={buttonClassName} onClick={onClose}>
            {labels.close}
          </Button>
        </div>
      </div>
    </div>
  );
}
