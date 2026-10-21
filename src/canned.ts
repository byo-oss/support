import {
  APIError,
  createAuthEndpoint,
  sessionMiddleware,
} from "better-auth/api";
import * as z from "zod";
import { requireAgent, type SupportEndpointContext } from "./access";
import { endpointRuntime } from "./adapter";
import type {
  CannedReplyListResponse,
  CannedReplyResponse,
  OkResponse,
} from "./client";
import { SUPPORT_ERROR_CODES } from "./error-codes";
import { type ResolvedSupportOptions, SUPPORT_LIMITS } from "./options";
import type { SupportCannedReplyRow } from "./schema";

type CannedData = Omit<SupportCannedReplyRow, "id">;

const byId = (id: string) => [{ field: "id", value: id }];

/**
 * `listSupportCannedReplies`, `saveSupportCannedReply`,
 * `deleteSupportCannedReply`. Spread into `agentEndpoints` (index.ts does not
 * wire this module directly). Canned replies are staff-wide: any agent with
 * `support:read` lists them; `support:manage` creates, edits and deletes.
 */
export function cannedEndpoints(opts: ResolvedSupportOptions) {
  return {
    /**
     * Canned replies sorted by title, at most 200. `q` matches the title
     * (contains, case-insensitive where the adapter supports it).
     */
    listSupportCannedReplies: createAuthEndpoint(
      "/support/agent/canned",
      {
        method: "GET",
        query: z
          .object({ q: z.string().max(SUPPORT_LIMITS.q).optional() })
          .optional(),
        use: [sessionMiddleware],
      },
      async (ctx) => {
        await requireAgent(ctx as SupportEndpointContext, opts, "read");
        const rt = endpointRuntime(ctx, opts);
        const q = ctx.query?.q?.trim();
        const rows = await rt.adapter.findMany<SupportCannedReplyRow>({
          model: "supportCannedReply",
          where: q
            ? [
                {
                  field: "title",
                  operator: "contains",
                  value: q,
                  mode: "insensitive",
                },
              ]
            : [],
          limit: SUPPORT_LIMITS.cannedListed,
          sortBy: { field: "title", direction: "asc" },
        });
        return rows satisfies CannedReplyListResponse;
      },
    ),

    /**
     * Creates a canned reply (`userId` = the author), or updates the one
     * named by `id` (its author is kept). Unknown `id`: 404
     * `CANNED_REPLY_NOT_FOUND`.
     */
    saveSupportCannedReply: createAuthEndpoint(
      "/support/agent/canned/save",
      {
        method: "POST",
        body: z.object({
          id: z.string().min(1).optional(),
          title: z.string().trim().min(1).max(SUPPORT_LIMITS.cannedTitle),
          body: z.string().min(1).max(SUPPORT_LIMITS.cannedBody),
        }),
        use: [sessionMiddleware],
      },
      async (ctx) => {
        const session = await requireAgent(
          ctx as SupportEndpointContext,
          opts,
          "manage",
        );
        const rt = endpointRuntime(ctx, opts);
        const { id, title, body } = ctx.body;
        const now = new Date();
        if (id) {
          const existing = await rt.adapter.findOne<SupportCannedReplyRow>({
            model: "supportCannedReply",
            where: byId(id),
          });
          if (!existing) {
            throw APIError.from(
              "NOT_FOUND",
              SUPPORT_ERROR_CODES.CANNED_REPLY_NOT_FOUND,
            );
          }
          const patch = { title, body, updatedAt: now };
          const updated = await rt.adapter.update<SupportCannedReplyRow>({
            model: "supportCannedReply",
            where: byId(id),
            update: patch,
          });
          return {
            cannedReply: updated ?? { ...existing, ...patch },
          } satisfies CannedReplyResponse;
        }
        const cannedReply = await rt.adapter.create<
          CannedData,
          SupportCannedReplyRow
        >({
          model: "supportCannedReply",
          data: {
            title,
            body,
            userId: session.user.id,
            createdAt: now,
            updatedAt: now,
          },
        });
        return { cannedReply } satisfies CannedReplyResponse;
      },
    ),

    /** Deletes a canned reply. `{ ok: true }` even when it is already gone. */
    deleteSupportCannedReply: createAuthEndpoint(
      "/support/agent/canned/delete",
      {
        method: "POST",
        body: z.object({ id: z.string().min(1) }),
        use: [sessionMiddleware],
      },
      async (ctx) => {
        await requireAgent(ctx as SupportEndpointContext, opts, "manage");
        const rt = endpointRuntime(ctx, opts);
        await rt.adapter.deleteMany({
          model: "supportCannedReply",
          where: byId(ctx.body.id),
        });
        return { ok: true } satisfies OkResponse;
      },
    ),
  };
}
