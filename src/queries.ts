// BYO_STUB: final owner N05. Signatures are final (contracts.md); bodies are neutral.
import { APIError } from "better-auth/api";
import type { SupportRuntime } from "./adapter";
import { SUPPORT_ERROR_CODES } from "./error-codes";
import type { SupportTicketRow, TicketStatus } from "./schema";

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

/** Opaque base64 of `{ at, ids }`. */
export function encodeCursor(cursor: ListCursor): string {
  return btoa(JSON.stringify({ at: cursor.at.toISOString(), ids: cursor.ids }));
}

/** Parses a cursor. Malformed, or more than 200 ids: 400 `INVALID_CURSOR`. */
export function decodeCursor(_value: string): ListCursor {
  throw APIError.from("BAD_REQUEST", SUPPORT_ERROR_CODES.INVALID_CURSOR);
}

/**
 * The customer's tickets, newest `lastMessageAt` first, one page of
 * `rt.opts.pageSize`: their own (`userId = me`) plus org-shared ones
 * (`visibility = organization` and `organizationId in` their orgs, chunked at
 * 90, skipped when they have none), merged, sorted by
 * `(lastMessageAt desc, id desc)` and deduped. Does not follow `mergedIntoId`.
 */
export async function listCustomerTickets(
  _rt: SupportRuntime,
  _input: { userId: string; filters: CustomerListFilters },
): Promise<TicketPage> {
  return { tickets: [], nextCursor: null };
}

/** The agent queue with filters, one page, plus queue-wide `counts`. */
export async function listAgentTickets(
  _rt: SupportRuntime,
  _input: { viewerId: string; filters: AgentListFilters },
): Promise<TicketPage & { counts: AgentCounts }> {
  return {
    tickets: [],
    nextCursor: null,
    counts: { open: 0, pending: 0, unassigned: 0, mine: 0 },
  };
}
