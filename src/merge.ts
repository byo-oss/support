import type { DBTransactionAdapter } from "better-auth";
import { SUPPORT_LIMITS } from "./options";
import type { SupportTicketRow } from "./schema";

/**
 * The ticket a read or inbound message should act on: follows `mergedIntoId`
 * to the end of the chain (at most `SUPPORT_LIMITS.mergeHops` hops, and never
 * back to a ticket already visited, so a cycle can't loop), loading each
 * target. A dangling `mergedIntoId` stops at the last ticket found.
 * Callers re-apply their access rule to the result.
 */
export async function resolveMergedTicket(
  adapter: DBTransactionAdapter,
  ticket: SupportTicketRow,
): Promise<SupportTicketRow> {
  let current = ticket;
  const visited = new Set([ticket.id]);
  for (let hop = 0; hop < SUPPORT_LIMITS.mergeHops; hop++) {
    const nextId = current.mergedIntoId ?? null;
    if (!nextId || visited.has(nextId)) break;
    const next = await adapter.findOne<SupportTicketRow>({
      model: "supportTicket",
      where: [{ field: "id", value: nextId }],
    });
    if (!next) break;
    visited.add(next.id);
    current = next;
  }
  return current;
}
