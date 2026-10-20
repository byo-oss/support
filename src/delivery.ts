// BYO_STUB: final owner N09. Signatures are final (contracts.md); bodies are neutral.
import type { SupportRuntime } from "./adapter";
import type { SupportMessageRow, SupportTicketRow } from "./schema";

/** What one sweep did. A `type` alias, so it assigns to `ByoSweepResult`. */
export type SupportSweepResult = {
  sent: number;
  skipped: number;
  retrying: number;
  failed: number;
  hasMore: boolean;
  /** Solved tickets closed after `autoCloseAfter`. */
  closed: number;
  /** Unattached uploads older than 24 h deleted. */
  pruned: number;
};

/**
 * After an agent `reply` (never a note): with a mailer, inserts one
 * `supportDelivery` (`pending`, due after `email.replyDelay`). When the delay
 * is 0 and `advanced.backgroundTasks.handler` exists, hands the send to it
 * (SPEC §5.4). No mailer: no-op.
 */
export async function enqueueReply(
  _rt: SupportRuntime,
  _input: { ticket: SupportTicketRow; message: SupportMessageRow },
): Promise<void> {}

/**
 * One sweep: reclaim stale `sending` rows (or fail them at `maxAttempts`),
 * claim and send due `pending` rows (at most `batchSize`), close solved
 * tickets past `autoCloseAfter`, and prune old unattached uploads through
 * `pruneUploads`. Without a mailer only the last two run.
 */
export async function runSweep(
  _rt: SupportRuntime,
  _now?: Date,
): Promise<SupportSweepResult> {
  return {
    sent: 0,
    skipped: 0,
    retrying: 0,
    failed: 0,
    hasMore: false,
    closed: 0,
    pruned: 0,
  };
}
