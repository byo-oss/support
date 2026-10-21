// Shared by both components. Every token is a whole literal string, so
// Tailwind's `@source` scan of dist finds it.

/**
 * A 44px minimum height on a coarse pointer (touch), for buttons, fields and
 * row targets. A mouse or trackpad keeps the compact default.
 */
export const TOUCH_TARGET = "pointer-coarse:min-h-11";

/** {@link TOUCH_TARGET} in both directions, for icon-only buttons (×). */
export const TOUCH_ICON = "pointer-coarse:min-h-11 pointer-coarse:min-w-11";
