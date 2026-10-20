// BYO_STUB: final owner N07. Signature is final (contracts.md); returns no endpoints yet.
import type { ResolvedSupportOptions } from "../options";

/**
 * The customer endpoints, keyed by `auth.api` key: `createSupportTicket`,
 * `listMySupportTickets`, `getSupportTicket`, `replyToSupportTicket`,
 * `updateMySupportTicket`, `markSupportTicketSeen`. Leave the return type
 * inferred so `$InferServerPlugin` sees every endpoint. Every endpoint that takes a ticket id resolves
 * it with `resolveMergedTicket` first, re-applies the access rule to the
 * resolved ticket, and works on the resolved ticket's id.
 */
export function customerEndpoints(_opts: ResolvedSupportOptions) {
  return {};
}
