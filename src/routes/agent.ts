// BYO_STUB: final owner N08. Signature is final (contracts.md); returns no endpoints yet.
import type { ResolvedSupportOptions } from "../options";

/**
 * The agent endpoints, keyed by `auth.api` key: `listSupportTickets`,
 * `getSupportTicketAsAgent`, `replyAsSupportAgent`, `updateSupportTickets`,
 * `markSupportTicketSeenAsAgent`, `listSupportTags`, plus the canned-reply
 * endpoints from `cannedEndpoints` in `../canned`. Leave the return type
 * inferred so `$InferServerPlugin` sees every endpoint. Every endpoint that takes a ticket id resolves
 * it with `resolveMergedTicket` first and works on the resolved ticket's id.
 */
export function agentEndpoints(_opts: ResolvedSupportOptions) {
  return {};
}
