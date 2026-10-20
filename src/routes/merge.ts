// BYO_STUB: final owner N14. Signature is final (contracts.md); returns no endpoints yet.
import type { ResolvedSupportOptions } from "../options";

/**
 * `mergeSupportTickets`: POST `/support/agent/merge`, gated `support:update`,
 * body `{ sourceId, targetId }`, returns `{ ticket }` (the target
 * `AgentTicket`). Moves messages and tags always, attachments only when
 * `opts.attachments` is set and deliveries only when `opts.mailer` is set
 * (those tables exist only then).
 */
export function mergeEndpoints(_opts: ResolvedSupportOptions) {
  return {};
}
