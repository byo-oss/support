import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultLabels,
  formatRelativeTime,
  type SupportLabels,
} from "../labels";

describe("defaultLabels", () => {
  it("has every SupportLabels key", () => {
    // the Record type fails to compile when a key is added to SupportLabels
    // and not listed here
    const keys: Record<keyof SupportLabels, true> = {
      support: true,
      newTicket: true,
      subject: true,
      message: true,
      send: true,
      reply: true,
      internalNote: true,
      attach: true,
      solve: true,
      reopen: true,
      rateGood: true,
      rateBad: true,
      shareWithOrganization: true,
      back: true,
      loadMore: true,
      empty: true,
      close: true,
      status: true,
      priority: true,
      unreadCount: true,
      ticketNumber: true,
      relativeTime: true,
      absoluteTime: true,
    };
    for (const key of Object.keys(keys)) {
      expect(defaultLabels).toHaveProperty(key);
    }
    expect(Object.keys(defaultLabels).sort()).toEqual(Object.keys(keys).sort());
  });

  it("fills the status and priority maps", () => {
    expect(Object.keys(defaultLabels.status).sort()).toEqual([
      "closed",
      "open",
      "pending",
      "solved",
    ]);
    expect(Object.keys(defaultLabels.priority).sort()).toEqual([
      "high",
      "low",
      "normal",
      "urgent",
    ]);
  });

  it("formats counts, numbers and times", () => {
    expect(defaultLabels.unreadCount(1)).toBe("1 unread ticket");
    expect(defaultLabels.unreadCount(3)).toBe("3 unread tickets");
    expect(defaultLabels.ticketNumber(123)).toBe("#123");
    expect(defaultLabels.relativeTime(new Date(Date.now() - 5 * 60_000))).toBe(
      "5m ago",
    );
  });
});

describe("formatRelativeTime", () => {
  const now = new Date("2026-10-20T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });
  afterEach(() => vi.useRealTimers());

  it("says just now under a minute, and for clock skew", () => {
    expect(formatRelativeTime(ago(0))).toBe("just now");
    expect(formatRelativeTime(ago(59_000))).toBe("just now");
    expect(formatRelativeTime(ago(-30_000))).toBe("just now");
  });

  it("counts minutes, hours and days", () => {
    expect(formatRelativeTime(ago(MINUTE))).toBe("1m ago");
    expect(formatRelativeTime(ago(59 * MINUTE + 59_000))).toBe("59m ago");
    expect(formatRelativeTime(ago(HOUR))).toBe("1h ago");
    expect(formatRelativeTime(ago(23 * HOUR))).toBe("23h ago");
    expect(formatRelativeTime(ago(DAY))).toBe("1d ago");
    expect(formatRelativeTime(ago(6 * DAY + 23 * HOUR))).toBe("6d ago");
  });

  it("falls back to the locale date after a week", () => {
    const old = ago(7 * DAY);
    expect(formatRelativeTime(old)).toBe(old.toLocaleDateString());
    const older = ago(90 * DAY);
    expect(formatRelativeTime(older)).toBe(older.toLocaleDateString());
  });

  it("accepts ISO strings and returns an empty string for an invalid date", () => {
    expect(formatRelativeTime(ago(2 * HOUR).toISOString())).toBe("2h ago");
    expect(formatRelativeTime("not a date")).toBe("");
  });
});
