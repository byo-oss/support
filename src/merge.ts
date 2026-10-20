// BYO_STUB: final owner N14. Signature is final (contracts.md); body is identity.
import type { DBTransactionAdapter } from "better-auth";
import type { SupportTicketRow } from "./schema";

/**
 * The ticket a read or inbound message should act on: follows `mergedIntoId`
 * to the end of the chain (at most 10 hops, so a cycle can't loop), loading
 * each target. A dangling `mergedIntoId` stops at the last ticket found.
 * Callers re-apply their access rule to the result.
 */
export async function resolveMergedTicket(
  _adapter: DBTransactionAdapter,
  ticket: SupportTicketRow,
): Promise<SupportTicketRow> {
  return ticket;
}
