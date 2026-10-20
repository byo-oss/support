// BYO_STUB: final owner N11a. Signature and result type are final (contracts.md); body is neutral.
import type { SupportRuntime } from "../adapter";
import type { DkimResolver } from "./verify";

export type InboundDropReason =
  | "too_large"
  | "unparseable"
  | "no_sender"
  | "loop"
  | "auto_reply"
  | "bounce"
  | "duplicate"
  | "sender_cap"
  | "unverified_cap"
  | "no_new_tickets";

/** What `receiveEmail` did. The endpoint answers 202 for every outcome. */
export type InboundResult =
  | { status: "created"; ticketId: string; messageId: string }
  | { status: "appended"; ticketId: string; messageId: string }
  | { status: "dropped"; reason: InboundDropReason };

/** Test seams. Production passes none. */
export type ReceiveEmailDeps = {
  /** DNS for the DKIM check (default: system DNS through mailauth). */
  resolver?: DkimResolver;
  now?: () => Date;
};

/**
 * Handles one raw inbound message: size cap, parse, drop rules (loop guard,
 * auto-replies, bounces, duplicate Message-ID incl. a unique-constraint
 * failure), caps, DKIM alignment, threading (reply token in a
 * `support+<token>@<replyDomain>` recipient, lowercased; then
 * `In-Reply-To`/`References`; then a new ticket when `newTickets`), merged
 * targets via `resolveMergedTicket`, the append rule, follow-up tickets for
 * closed ones (`followup_of` event), attachment parts through
 * `storeInboundPart` (writing an `attachment_dropped` event for each drop).
 * Never throws for a message it decided to drop.
 */
export async function receiveEmail(
  _rt: SupportRuntime,
  _raw: Uint8Array,
  _deps: ReceiveEmailDeps = {},
): Promise<InboundResult> {
  return { status: "dropped", reason: "unparseable" };
}
