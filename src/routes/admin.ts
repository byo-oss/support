import { createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import * as z from "zod";
import { requireAgent, type SupportEndpointContext } from "../access";
import { endpointRuntime } from "../adapter";
import type { DeleteTicketsResponse } from "../client";
import { deleteTickets } from "../lifecycle";
import { type ResolvedSupportOptions, SUPPORT_LIMITS } from "../options";

/** `deleteSupportTickets`: POST `/support/agent/delete`, gated `support:delete`, body `{ ids }` (1–100), returns `{ deleted }`. */
export function adminEndpoints(opts: ResolvedSupportOptions) {
  return {
    /**
     * Permanently deletes the tickets named (no merge following) with their
     * messages, tags, deliveries and attachments, blobs first. Ids that don't
     * exist are ignored. Tickets merged into a deleted one lose their
     * `mergedIntoId`. Returns how many tickets were deleted.
     */
    deleteSupportTickets: createAuthEndpoint(
      "/support/agent/delete",
      {
        method: "POST",
        body: z.object({
          ids: z.array(z.string().min(1)).min(1).max(SUPPORT_LIMITS.ids),
        }),
        use: [sessionMiddleware],
      },
      async (ctx) => {
        await requireAgent(ctx as SupportEndpointContext, opts, "delete");
        const deleted = await deleteTickets(
          endpointRuntime(ctx, opts),
          ctx.body.ids,
        );
        return { deleted } satisfies DeleteTicketsResponse;
      },
    ),
  };
}
