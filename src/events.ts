import { queueAfterTransactionHook } from "@better-auth/core/context";
import type { ByoEvent } from "@byo-oss/core";
import type { SupportRuntime } from "./adapter";
import type { SupportTicketRow } from "./schema";

/** Every event type support emits through `onEvent`. */
export const SUPPORT_EVENT_TYPES = [
  "support.ticket.created",
  "support.ticket.status_changed",
  "support.ticket.assigned",
  "support.ticket.merged",
  "support.customer.replied",
  "support.agent.replied",
  "support.note.added",
  "support.agent.mentioned",
] as const;

export type SupportEventType = (typeof SUPPORT_EVENT_TYPES)[number];

/**
 * A support event: a `ByoEvent` whose subject is always the ticket. `data`
 * carries ids, statuses and kinds only, never message bodies, and always the
 * ticket's `visibility` (`"private" | "organization"`) as of the event. A
 * private ticket's events still carry its `organizationId`: a consumer that
 * fans out by organization must skip `visibility: "private"`. Events about an
 * internal note (`support.note.added`, and `support.agent.mentioned` with
 * `kind: "note"`) carry no `organizationId` at all, so there is no customer
 * organization for a handler to fan them out to.
 *
 * | type | userId | data (plus `visibility`) |
 * |---|---|---|
 * | `support.ticket.created` | requester | `{ ticketId, number, channel }` |
 * | `support.ticket.status_changed` | requester | `{ ticketId, from, to }` |
 * | `support.ticket.assigned` | new assignee | `{ ticketId, from, to }` (user ids or null) |
 * | `support.ticket.merged` | requester | `{ ticketId, sourceId, targetId }` (subject = target) |
 * | `support.customer.replied` | requester | `{ ticketId, messageId, channel }` |
 * | `support.agent.replied` | requester | `{ ticketId, messageId, status }` |
 * | `support.note.added` | — | `{ ticketId, messageId }` |
 * | `support.agent.mentioned` | the mentioned agent | `{ ticketId, messageId, kind }` |
 */
export type SupportEvent = Omit<ByoEvent, "type" | "subject"> & {
  type: SupportEventType;
  subject: { type: "supportTicket"; id: string };
};

/** Logger shape `emit` uses: better-auth's `context.logger` fits. */
export type SupportLogger = {
  error: (message: string, ...args: unknown[]) => void;
};

/**
 * Builds a `SupportEvent` about a ticket: `occurredAt` now, subject the
 * ticket, `organizationId` from the ticket when it has one, and the ticket's
 * `visibility` added to `data`. With `internal` (an event about a note) the
 * `organizationId` is left out: the customer's organization must not be
 * addressable from a staff-only event.
 */
export function ticketEvent(
  type: SupportEventType,
  ticket: Pick<SupportTicketRow, "id" | "organizationId" | "visibility">,
  input: {
    actorId: string | null;
    userId?: string | null;
    data: Record<string, unknown>;
    occurredAt?: Date;
    /** The event is about an internal note: no `organizationId`. */
    internal?: boolean;
  },
): SupportEvent {
  return {
    type,
    occurredAt: input.occurredAt ?? new Date(),
    actorId: input.actorId,
    ...(input.userId ? { userId: input.userId } : {}),
    ...(ticket.organizationId && !input.internal
      ? { organizationId: ticket.organizationId }
      : {}),
    subject: { type: "supportTicket", id: ticket.id },
    data: { ...input.data, visibility: ticket.visibility },
  };
}

/**
 * Hands an event to `onEvent`, after the write that caused it commits.
 *
 * - A write made through the base adapter (`rt.adapter` is the context's
 *   adapter) is durable when it returns, so the handler runs now, awaited.
 * - A write that joined a caller's transaction (`getCurrentAdapter` inside
 *   `runWithTransaction`) queues the handler with `queueAfterTransactionHook`:
 *   it runs once the transaction commits and is dropped if it rolls back.
 *
 * Never throws or rejects: the handler's error is caught and logged inside the
 * queued hook (an uncaught one would rethrow after the commit), `onError` is
 * passed as well, and a broken logger is ignored. The event is built before
 * queueing, so `occurredAt` is the time of the write.
 */
export async function emit(
  rt: Pick<SupportRuntime, "context" | "adapter" | "opts">,
  event: SupportEvent,
): Promise<void> {
  const onEvent = rt.opts.onEvent;
  if (!onEvent) return;
  const report = (error: unknown) => {
    try {
      rt.context.logger.error(
        `[@byo-oss/support] onEvent failed for ${event.type}`,
        error,
      );
    } catch {
      // a broken logger must not fail the request either
    }
  };
  const run = async () => {
    try {
      await onEvent(event as ByoEvent);
    } catch (error) {
      report(error);
    }
  };
  try {
    if ((rt.adapter as unknown) === rt.context.adapter) await run();
    else
      await queueAfterTransactionHook(run, { onError: async (e) => report(e) });
  } catch (error) {
    report(error);
  }
}
