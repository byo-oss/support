import type { Where } from "better-auth";
import { APIError } from "better-auth/api";
import { myOrganizationIds } from "./access";
import { chunk, findAll, type SupportRuntime } from "./adapter";
import { SUPPORT_ERROR_CODES } from "./error-codes";
import { SUPPORT_LIMITS } from "./options";
import type {
  SupportTicketRow,
  SupportTicketTagRow,
  TicketStatus,
} from "./schema";

/** Filters of `listMySupportTickets`. */
export type CustomerListFilters = {
  status?: TicketStatus;
  organizationId?: string;
  /** `#123` or `123` matches that number exactly; anything else matches subject (contains). */
  q?: string;
  cursor?: string;
};

/** Filters of `listSupportTickets`. */
export type AgentListFilters = {
  status?: TicketStatus;
  /** A user id, `"me"` (the caller) or `"none"` (unassigned). */
  assignee?: string;
  tag?: string;
  organizationId?: string;
  q?: string;
  cursor?: string;
};

/**
 * Queue-wide counts (they ignore the filters): `open` and `pending` by
 * status; `unassigned` = open or pending with no assignee; `mine` = open or
 * pending assigned to the caller.
 */
export type AgentCounts = {
  open: number;
  pending: number;
  unassigned: number;
  mine: number;
};

/** Decoded list cursor: the last row's `lastMessageAt` and the ids already returned with it (≤ 200). */
export type ListCursor = { at: Date; ids: string[] };

export type TicketPage = {
  tickets: SupportTicketRow[];
  nextCursor: string | null;
};

// ---------------------------------------------------------------------------
// Cursor (SPEC §2.7): `{ at, ids }`, never `id > cursor`
// ---------------------------------------------------------------------------

/** Opaque base64 of `{ at, ids }`. */
export function encodeCursor(cursor: ListCursor): string {
  const json = JSON.stringify({ at: cursor.at.toISOString(), ids: cursor.ids });
  // UTF-8 first, so any id survives `btoa`; URL-safe, so it travels in a query string
  let binary = "";
  for (const byte of new TextEncoder().encode(json)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Parses a cursor. Malformed, or more than 200 ids: 400 `INVALID_CURSOR`. */
export function decodeCursor(value: string): ListCursor {
  const invalid = () =>
    APIError.from("BAD_REQUEST", SUPPORT_ERROR_CODES.INVALID_CURSOR);
  let parsed: unknown;
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    throw invalid();
  }
  if (typeof parsed !== "object" || parsed === null) throw invalid();
  const { at, ids } = parsed as { at?: unknown; ids?: unknown };
  if (typeof at !== "string") throw invalid();
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) throw invalid();
  if (
    !Array.isArray(ids) ||
    ids.length > SUPPORT_LIMITS.cursorIds ||
    !ids.every((id) => typeof id === "string" && id.length > 0)
  ) {
    throw invalid();
  }
  return { at: date, ids: ids as string[] };
}

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

const timeOf = (row: Pick<SupportTicketRow, "lastMessageAt">) =>
  new Date(row.lastMessageAt).getTime();

// `(lastMessageAt desc, id desc)`; ids compare with `<`, the same on every adapter
const newestFirst = (a: SupportTicketRow, b: SupportTicketRow) =>
  timeOf(b) - timeOf(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/**
 * One page across several ticket queries (one per `where` list). Each query
 * gets the cursor bound (`lastMessageAt lte at`) and fetches
 * `pageSize + 1 + ids.length` rows by `lastMessageAt` (the adapter sorts on
 * one field); the rows are merged, deduped by id, stripped of the ids already
 * returned at `at`, and ordered by `(lastMessageAt desc, id desc)` in code.
 * Any query that filled its window leaves more than `pageSize` rows after
 * the merge, so `nextCursor` is set exactly when rows remain.
 */
async function pageTickets(
  rt: SupportRuntime,
  queries: Where[][],
  cursor: ListCursor | null,
): Promise<TicketPage> {
  const { pageSize } = rt.opts;
  const returned = new Set(cursor?.ids ?? []);
  const bound: Where[] = cursor
    ? [{ field: "lastMessageAt", operator: "lte", value: cursor.at }]
    : [];
  const pages = await Promise.all(
    queries.map((where) =>
      rt.adapter.findMany<SupportTicketRow>({
        model: "supportTicket",
        where: [...where, ...bound],
        limit: pageSize + 1 + returned.size,
        sortBy: { field: "lastMessageAt", direction: "desc" },
      }),
    ),
  );
  const fresh = new Map<string, SupportTicketRow>();
  for (const row of pages.flat()) {
    if (!returned.has(row.id)) fresh.set(row.id, row);
  }
  const sorted = [...fresh.values()].sort(newestFirst);
  const tickets = sorted.slice(0, pageSize);
  const last = tickets[tickets.length - 1];
  if (sorted.length <= pageSize || !last) {
    return { tickets, nextCursor: null };
  }
  // the ids returned at the last timestamp, plus those returned with it on
  // earlier pages, so a tie spanning several pages never repeats a row
  const at = timeOf(last);
  const ids = tickets.filter((t) => timeOf(t) === at).map((t) => t.id);
  if (cursor && cursor.at.getTime() === at) ids.push(...cursor.ids);
  return { tickets, nextCursor: encodeCursor({ at: new Date(at), ids }) };
}

// the largest number a ticket `number` column holds on every SQL database
const MAX_TICKET_NUMBER = 2_147_483_647;

// `#123` or `123`: that number exactly; anything else: subject contains
function searchWhere(q: string | undefined): Where[] {
  const text = q?.trim();
  if (!text) return [];
  const match = /^#?(\d+)$/.exec(text);
  const number = match ? Number(match[1]) : Number.NaN;
  if (Number.isInteger(number) && number <= MAX_TICKET_NUMBER) {
    return [{ field: "number", value: number }];
  }
  // subject isn't indexed, so the case-insensitive match costs nothing extra
  return [
    {
      field: "subject",
      operator: "contains",
      value: text,
      mode: "insensitive",
    },
  ];
}

const statusWhere = (status: TicketStatus | undefined): Where[] =>
  status ? [{ field: "status", value: status }] : [];

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

/**
 * The customer's tickets, newest `lastMessageAt` first, one page of
 * `rt.opts.pageSize`: their own (`userId = me`) plus org-shared ones
 * (`visibility = organization` and `organizationId in` their orgs, chunked at
 * 90, skipped when they have none), merged, sorted by
 * `(lastMessageAt desc, id desc)` and deduped. Does not follow `mergedIntoId`.
 */
export async function listCustomerTickets(
  rt: SupportRuntime,
  input: { userId: string; filters: CustomerListFilters },
): Promise<TicketPage> {
  const { userId, filters } = input;
  const cursor = filters.cursor ? decodeCursor(filters.cursor) : null;
  const common = [...statusWhere(filters.status), ...searchWhere(filters.q)];
  const own: Where[] = [
    { field: "userId", value: userId },
    ...(filters.organizationId
      ? [{ field: "organizationId", value: filters.organizationId }]
      : []),
    ...common,
  ];
  // current memberships only: a removed teammate loses shared tickets at once
  let orgIds = await myOrganizationIds(rt.adapter, userId);
  if (filters.organizationId) {
    orgIds = orgIds.filter((id) => id === filters.organizationId);
  }
  const shared = chunk(orgIds).map((part): Where[] => [
    { field: "visibility", value: "organization" },
    { field: "organizationId", operator: "in", value: part },
    ...common,
  ]);
  return pageTickets(rt, [own, ...shared], cursor);
}

/** The agent queue with filters, one page, plus queue-wide `counts`. */
export async function listAgentTickets(
  rt: SupportRuntime,
  input: { viewerId: string; filters: AgentListFilters },
): Promise<TicketPage & { counts: AgentCounts }> {
  const { viewerId, filters } = input;
  const cursor = filters.cursor ? decodeCursor(filters.cursor) : null;
  const where: Where[] = [...statusWhere(filters.status)];
  if (filters.assignee === "me") {
    where.push({ field: "assigneeId", value: viewerId });
  } else if (filters.assignee === "none") {
    where.push({ field: "assigneeId", value: null });
  } else if (filters.assignee) {
    where.push({ field: "assigneeId", value: filters.assignee });
  }
  if (filters.organizationId) {
    where.push({ field: "organizationId", value: filters.organizationId });
  }
  where.push(...searchWhere(filters.q));

  let queries: Where[][] = [where];
  if (filters.tag !== undefined) {
    // tags are stored trimmed and lowercased; page every tag row, then query
    // the tickets 90 ids at a time with the same filters and cursor bound
    const tag = filters.tag.trim().toLowerCase();
    const rows = tag
      ? await findAll<SupportTicketTagRow>(rt.adapter, {
          model: "supportTicketTag",
          where: [{ field: "tag", value: tag }],
          max: Number.MAX_SAFE_INTEGER,
        })
      : [];
    const ticketIds = [...new Set(rows.map((row) => row.ticketId))];
    queries = chunk(ticketIds).map((part): Where[] => [
      { field: "id", operator: "in", value: part },
      ...where,
    ]);
  }

  const [page, counts] = await Promise.all([
    pageTickets(rt, queries, cursor),
    queueCounts(rt, viewerId),
  ]);
  return { ...page, counts };
}

// queue-wide, ignoring the filters; each count is one AND-only where list
async function queueCounts(
  rt: SupportRuntime,
  viewerId: string,
): Promise<AgentCounts> {
  const count = (where: Where[]) =>
    rt.adapter.count({ model: "supportTicket", where });
  const active: Where = {
    field: "status",
    operator: "in",
    value: ["open", "pending"],
  };
  const [open, pending, unassigned, mine] = await Promise.all([
    count([{ field: "status", value: "open" }]),
    count([{ field: "status", value: "pending" }]),
    count([active, { field: "assigneeId", value: null }]),
    count([active, { field: "assigneeId", value: viewerId }]),
  ]);
  return { open, pending, unassigned, mine };
}
