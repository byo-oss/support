import type { ByoEvent, ByoEventHandler } from "@byo-oss/core";
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
 * fans out by organization must skip `visibility: "private"`.
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
 * `visibility` added to `data`.
 */
export function ticketEvent(
  type: SupportEventType,
  ticket: Pick<SupportTicketRow, "id" | "organizationId" | "visibility">,
  input: {
    actorId: string | null;
    userId?: string | null;
    data: Record<string, unknown>;
    occurredAt?: Date;
  },
): SupportEvent {
  return {
    type,
    occurredAt: input.occurredAt ?? new Date(),
    actorId: input.actorId,
    ...(input.userId ? { userId: input.userId } : {}),
    ...(ticket.organizationId ? { organizationId: ticket.organizationId } : {}),
    subject: { type: "supportTicket", id: ticket.id },
    data: { ...input.data, visibility: ticket.visibility },
  };
}

/**
 * Hands an event to `onEvent`, after the write that caused it returned.
 * Awaits the handler, catches and logs anything it throws, and never throws
 * itself, so an event consumer can't fail a request.
 */
export async function emit(
  opts: { onEvent?: ByoEventHandler | undefined },
  event: SupportEvent,
  logger?: SupportLogger,
): Promise<void> {
  if (!opts.onEvent) return;
  try {
    await opts.onEvent(event as ByoEvent);
  } catch (error) {
    try {
      (logger ?? console).error(
        `[@byo-oss/support] onEvent failed for ${event.type}`,
        error,
      );
    } catch {
      // a broken logger must not fail the request either
    }
  }
}
