import type { Where } from "better-auth";
import {
  APIError,
  createAuthEndpoint,
  sessionMiddleware,
} from "better-auth/api";
import * as z from "zod";
import { requireAgent, type SupportEndpointContext } from "../access";
import {
  chunk,
  endpointRuntime,
  findAll,
  findUsersByIds,
  lowerEmail,
  type SupportRuntime,
} from "../adapter";
import type { AgentTicketResponse } from "../client";
import { SUPPORT_ERROR_CODES } from "../error-codes";
import { emit, ticketEvent } from "../events";
import { type ResolvedSupportOptions, SUPPORT_LIMITS } from "../options";
import type {
  SupportEventData,
  SupportTicketRow,
  SupportTicketTagRow,
} from "../schema";
import { toAgentTicket } from "../serialize";
import { addMessage, applyStatus } from "../tickets";

const byId = (id: string): Where[] => [{ field: "id", value: id }];

const notAllowed = () =>
  APIError.from("BAD_REQUEST", SUPPORT_ERROR_CODES.MERGE_NOT_ALLOWED);

const notFound = () =>
  APIError.from("NOT_FOUND", SUPPORT_ERROR_CODES.TICKET_NOT_FOUND);

/**
 * The merge rule (PRD "Merge rules"): the same requester (the same `userId`,
 * or both account-less with the same `requesterEmail`) and the same
 * `organizationId` (both null counts as the same).
 */
function mayMerge(source: SupportTicketRow, target: SupportTicketRow): boolean {
  const sourceUser = source.userId ?? null;
  const targetUser = target.userId ?? null;
  let sameRequester: boolean;
  if (sourceUser || targetUser) {
    sameRequester = sourceUser === targetUser;
  } else {
    const sourceEmail = source.requesterEmail
      ? lowerEmail(source.requesterEmail)
      : null;
    const targetEmail = target.requesterEmail
      ? lowerEmail(target.requesterEmail)
      : null;
    sameRequester = sourceEmail !== null && sourceEmail === targetEmail;
  }
  const sameOrganization =
    (source.organizationId ?? null) === (target.organizationId ?? null);
  return sameRequester && sameOrganization;
}

// moves every row of `model` from one ticket to the other; an `eq` filter, so
// no `in` list to chunk, and the update count is never read
async function moveRows(
  rt: SupportRuntime,
  model: "supportMessage" | "supportAttachment" | "supportDelivery",
  from: string,
  to: string,
): Promise<void> {
  await rt.adapter.updateMany({
    model,
    where: [{ field: "ticketId", value: from }],
    update: { ticketId: to },
  });
}

// moves the source's tags to the target, dropping each one the target (or an
// earlier source row) already has
async function moveTags(
  rt: SupportRuntime,
  from: string,
  to: string,
): Promise<void> {
  const read = (ticketId: string) =>
    findAll<SupportTicketTagRow>(rt.adapter, {
      model: "supportTicketTag",
      where: [{ field: "ticketId", value: ticketId }],
      max: SUPPORT_LIMITS.tagsListed,
    });
  const [sourceRows, targetRows] = await Promise.all([read(from), read(to)]);
  const kept = new Set(targetRows.map((row) => row.tag));
  const moving: string[] = [];
  const duplicates: string[] = [];
  for (const row of sourceRows) {
    if (kept.has(row.tag)) {
      duplicates.push(row.id);
    } else {
      kept.add(row.tag);
      moving.push(row.id);
    }
  }
  for (const ids of chunk(duplicates)) {
    await rt.adapter.deleteMany({
      model: "supportTicketTag",
      where: [{ field: "id", operator: "in", value: ids }],
    });
  }
  for (const ids of chunk(moving)) {
    await rt.adapter.updateMany({
      model: "supportTicketTag",
      where: [{ field: "id", operator: "in", value: ids }],
      update: { ticketId: to },
    });
  }
}

/** The later of two dates (as stored: a `Date`, or a string on some adapters). */
function laterOf(a: Date | string, b: Date | string): Date {
  const x = new Date(a);
  const y = new Date(b);
  return x.getTime() >= y.getTime() ? x : y;
}

/**
 * `mergeSupportTickets`: POST `/support/agent/merge`, gated `support:update`,
 * body `{ sourceId, targetId }`, returns `{ ticket }` (the target
 * `AgentTicket`). Moves messages and tags always, attachments only when
 * `opts.attachments` is set and deliveries only when `opts.mailer` is set
 * (those tables exist only then).
 */
export function mergeEndpoints(opts: ResolvedSupportOptions) {
  return {
    /**
     * Merges `sourceId` into `targetId`, acting on the ids given (no merge
     * following). Refused with `MERGE_NOT_ALLOWED` for the same id, a source
     * or target already merged, or a different requester or organization.
     * Messages, tags (deduped), attachments and deliveries move to the
     * target; the target takes the stricter `visibility` (`private` wins)
     * and `verified` (`false` wins) and the later `lastMessageAt`; the
     * source is closed with `mergedIntoId`. Both get a `merged` event row, and
     * `support.ticket.merged` is emitted.
     */
    mergeSupportTickets: createAuthEndpoint(
      "/support/agent/merge",
      {
        method: "POST",
        body: z.object({
          sourceId: z.string().min(1),
          targetId: z.string().min(1),
        }),
        use: [sessionMiddleware],
      },
      async (ctx) => {
        const session = await requireAgent(
          ctx as SupportEndpointContext,
          opts,
          "update",
        );
        const rt = endpointRuntime(ctx, opts);
        const { sourceId, targetId } = ctx.body;
        const actorId = session.user.id;
        if (sourceId === targetId) throw notAllowed();

        const [source, target] = await Promise.all(
          [sourceId, targetId].map((id) =>
            rt.adapter.findOne<SupportTicketRow>({
              model: "supportTicket",
              where: byId(id),
            }),
          ),
        );
        if (!source || !target) throw notFound();
        if (source.mergedIntoId || target.mergedIntoId) throw notAllowed();
        if (!mayMerge(source, target)) throw notAllowed();

        // The source points at the target first, so anything that arrives
        // mid-merge already resolves there. Children move before the source's
        // own status and event rows are written, which stay on the source.
        await rt.adapter.update({
          model: "supportTicket",
          where: byId(source.id),
          update: { mergedIntoId: target.id },
        });
        await moveRows(rt, "supportMessage", source.id, target.id);
        await moveTags(rt, source.id, target.id);
        if (opts.attachments) {
          // storage keys carry the organization, which is the same: no blob moves
          await moveRows(rt, "supportAttachment", source.id, target.id);
        }
        if (opts.mailer) {
          await moveRows(rt, "supportDelivery", source.id, target.id);
        }

        const patch = {
          visibility:
            source.visibility === "private" || target.visibility === "private"
              ? ("private" as const)
              : target.visibility,
          verified: source.verified === true && target.verified === true,
          // the moved messages count as the target's activity now
          lastMessageAt: laterOf(source.lastMessageAt, target.lastMessageAt),
          updatedAt: new Date(),
        };
        const merged =
          (await rt.adapter.update<SupportTicketRow>({
            model: "supportTicket",
            where: byId(target.id),
            update: patch,
          })) ?? ({ ...target, ...patch } as SupportTicketRow);

        const closed = await applyStatus(rt, {
          ticket: { ...source, mergedIntoId: target.id },
          to: "closed",
          actorId,
          authorType: "agent",
        });

        const event = (ticket: SupportTicketRow, data: SupportEventData) =>
          addMessage(rt, {
            ticket,
            kind: "event",
            authorType: "agent",
            userId: actorId,
            body: "",
            data,
            channel: "web",
            verified: true,
            actorId,
          });
        await event(merged, { type: "merged", from: source.id });
        await event(closed, { type: "merged", to: target.id });

        await emit(
          opts,
          ticketEvent("support.ticket.merged", merged, {
            actorId,
            userId: merged.userId,
            data: { ticketId: merged.id, sourceId: source.id, targetId },
          }),
          rt.context.logger,
        );

        const fresh =
          (await rt.adapter.findOne<SupportTicketRow>({
            model: "supportTicket",
            where: byId(target.id),
          })) ?? merged;
        const [tagRows, users] = await Promise.all([
          findAll<SupportTicketTagRow>(rt.adapter, {
            model: "supportTicketTag",
            where: [{ field: "ticketId", value: fresh.id }],
            max: SUPPORT_LIMITS.tagsListed,
          }),
          findUsersByIds(rt.adapter, [fresh.userId, fresh.assigneeId]),
        ]);
        const tags = [...new Set(tagRows.map((row) => row.tag))].sort();
        return {
          ticket: toAgentTicket(fresh, { users, tags }),
        } satisfies AgentTicketResponse;
      },
    ),
  };
}
