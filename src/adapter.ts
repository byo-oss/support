import {
  type AuthContext,
  type DBTransactionAdapter,
  type GenericEndpointContext,
  getCurrentAdapter,
  type User,
  type Where,
} from "better-auth";
import type { ResolvedSupportOptions } from "./options";

// Cloudflare D1 binds at most 100 parameters per query, so `in` lists are split
// into chunks that leave room for the rest of the where clause (SPEC §2.7)
export const IN_CHUNK = 90;

// findMany returns 100 rows unless given a limit
export const FIND_PAGE = 1000;

/** Explicit cap on a user's memberships when listing their organizations. */
export const MEMBERSHIP_LIMIT = 1000;

// ---------------------------------------------------------------------------
// Query tagging, for the strict test wrapper
// ---------------------------------------------------------------------------

const supportQueries = new WeakSet<object>();

/**
 * Marks a query object as issued by support. The strict adapter wrapper in
 * `test-utils.ts` checks `limit` and `in` sizes on every `support*` model call
 * and, for other models (`member`, `user`), only on queries marked here, so
 * better-auth's own organization queries pass untouched. Costs nothing in
 * production.
 */
export function markSupportQuery<T extends object>(query: T): T {
  supportQueries.add(query);
  return query;
}

/** Whether `markSupportQuery` marked this query object. */
export function isSupportQuery(query: unknown): boolean {
  return (
    typeof query === "object" && query !== null && supportQueries.has(query)
  );
}

// ---------------------------------------------------------------------------
// Chunking and paging (SPEC §2.7)
// ---------------------------------------------------------------------------

/** Splits `values` into chunks of `size`. An empty list gives no chunks, so no query runs. */
export function chunk<T>(values: readonly T[], size = IN_CHUNK): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    chunks.push(values.slice(i, i + size));
  }
  return chunks;
}

/**
 * Every row whose `field` is one of `values`, however many values or matching
 * rows there are: deduped values, chunks of 90, pages of 1000 sorted by id.
 * No query runs for an empty `values`.
 */
export async function findManyIn<T>(
  adapter: DBTransactionAdapter,
  {
    model,
    field,
    values,
    where = [],
    select,
  }: {
    model: string;
    field: string;
    values: readonly string[];
    where?: Where[];
    select?: string[];
  },
): Promise<T[]> {
  const rows: T[] = [];
  for (const part of chunk([...new Set(values)])) {
    for (let offset = 0; ; offset += FIND_PAGE) {
      const page = await adapter.findMany<T>(
        markSupportQuery({
          model,
          where: [...where, { field, operator: "in" as const, value: part }],
          limit: FIND_PAGE,
          offset,
          sortBy: { field: "id", direction: "asc" as const },
          ...(select ? { select } : {}),
        }),
      );
      rows.push(...page);
      if (page.length < FIND_PAGE) break;
    }
  }
  return rows;
}

/**
 * Every row matching `where`, paged at 1000 sorted by id, stopping after
 * `max` rows. For lists that must be read whole (tag lookups).
 */
export async function findAll<T>(
  adapter: DBTransactionAdapter,
  {
    model,
    where,
    select,
    max,
  }: { model: string; where: Where[]; select?: string[]; max: number },
): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; rows.length < max; offset += FIND_PAGE) {
    const page = await adapter.findMany<T>(
      markSupportQuery({
        model,
        where,
        limit: Math.min(FIND_PAGE, max - rows.length),
        offset,
        sortBy: { field: "id", direction: "asc" as const },
        ...(select ? { select } : {}),
      }),
    );
    rows.push(...page);
    if (page.length < FIND_PAGE) break;
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Emails
// ---------------------------------------------------------------------------

/**
 * The stored form of an email address: trimmed and lowercased. Support stores
 * and matches emails this way with plain `eq`, never `mode: "insensitive"`
 * (which skips the index).
 */
export function lowerEmail(email: string): string {
  return email.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// member / user reads (the only ones support makes; all go through here)
// ---------------------------------------------------------------------------

export type MemberRow = {
  id: string;
  userId: string;
  organizationId: string;
  role: string;
  createdAt: Date;
};

export type UserRow = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image?: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** The public face of a user: what serializers show. */
export type UserSummary = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
};

const toSummary = (user: UserRow): UserSummary => ({
  id: user.id,
  name: user.name,
  email: user.email,
  emailVerified: user.emailVerified,
  image: user.image ?? null,
});

/** The member row of `userId` in `organizationId`, or null. */
export function findMember(
  adapter: DBTransactionAdapter,
  { userId, organizationId }: { userId: string; organizationId: string },
): Promise<MemberRow | null> {
  return adapter.findOne<MemberRow>(
    markSupportQuery({
      model: "member",
      where: [
        { field: "userId", value: userId },
        { field: "organizationId", value: organizationId },
      ],
    }),
  );
}

/** A user's memberships, at most `limit` (default 1000). */
export function listMemberships(
  adapter: DBTransactionAdapter,
  userId: string,
  limit = MEMBERSHIP_LIMIT,
): Promise<MemberRow[]> {
  return adapter.findMany<MemberRow>(
    markSupportQuery({
      model: "member",
      where: [{ field: "userId", value: userId }],
      limit,
      sortBy: { field: "id", direction: "asc" as const },
    }),
  );
}

/** One user by id, or null. */
export async function findUserById(
  adapter: DBTransactionAdapter,
  id: string,
): Promise<UserSummary | null> {
  const user = await adapter.findOne<UserRow>(
    markSupportQuery({ model: "user", where: [{ field: "id", value: id }] }),
  );
  return user ? toSummary(user) : null;
}

/** Users by id, keyed by id. Missing ids are absent. No query for an empty list. */
export async function findUsersByIds(
  adapter: DBTransactionAdapter,
  ids: readonly (string | null | undefined)[],
): Promise<Map<string, UserSummary>> {
  const wanted = ids.filter((id): id is string => !!id);
  const users = await findManyIn<UserRow>(adapter, {
    model: "user",
    field: "id",
    values: wanted,
  });
  return new Map(users.map((user) => [user.id, toSummary(user)]));
}

/** The user with this email (matched lowercased with `eq`), or null. */
export async function findUserByEmail(
  adapter: DBTransactionAdapter,
  email: string,
): Promise<UserSummary | null> {
  const user = await adapter.findOne<UserRow>(
    markSupportQuery({
      model: "user",
      where: [{ field: "email", value: lowerEmail(email) }],
    }),
  );
  return user ? toSummary(user) : null;
}

// ---------------------------------------------------------------------------
// Runtime: which adapter and options a module works with
// ---------------------------------------------------------------------------

/**
 * Any better-auth instance (your `auth`). Loose on purpose: a typed
 * instance's `$context` doesn't assign to the generic `AuthContext`.
 */
export type AuthWithContext = { $context: Promise<object> };

/**
 * What service functions receive as their first argument.
 * - `context`: better-auth's context (options, logger, internalAdapter).
 * - `adapter`: the adapter to use for every query. In endpoints it is
 *   `ctx.context.adapter`; in exported functions and database hooks it is
 *   `getCurrentAdapter(context.adapter)`, so they join a caller's transaction.
 * - `opts`: the resolved support options.
 */
export type SupportRuntime = {
  context: AuthContext;
  adapter: DBTransactionAdapter;
  opts: ResolvedSupportOptions;
};

/** The runtime inside an endpoint handler. */
export function endpointRuntime(
  ctx: { context: AuthContext },
  opts: ResolvedSupportOptions,
): SupportRuntime {
  return { context: ctx.context, adapter: ctx.context.adapter, opts };
}

/**
 * The runtime for a database hook or any code holding the context captured
 * in `init`: resolves the adapter with `getCurrentAdapter`, because the hook
 * may run inside better-auth's transaction (sign-up) and `context` can be
 * null there.
 */
export async function contextRuntime(
  context: AuthContext,
  opts: ResolvedSupportOptions,
): Promise<SupportRuntime> {
  return { context, adapter: await getCurrentAdapter(context.adapter), opts };
}

/**
 * The runtime for an exported server function called with the app's `auth`.
 * Finds support's resolved options on the installed plugin and resolves the
 * adapter with `getCurrentAdapter`, so a call inside `runWithTransaction`
 * uses that transaction. Throws when support isn't installed on `auth`.
 */
export async function authRuntime(
  auth: AuthWithContext,
  caller: string,
): Promise<SupportRuntime> {
  const context = (await auth.$context) as AuthContext;
  const plugin = context.options.plugins?.find((p) => p.id === "support") as
    | { options?: ResolvedSupportOptions }
    | undefined;
  if (!plugin?.options) {
    throw new Error(
      `[@byo-oss/support] ${caller} needs the support plugin installed on this auth instance`,
    );
  }
  return contextRuntime(context, plugin.options);
}

/**
 * A `databaseHooks.user.*.after` hook as support returns them from `init`.
 * `user` can be null (`update.after` when no row matched) and `context` is
 * null outside an endpoint, so hooks use the context captured in `init`
 * (`contextRuntime`), never this argument's.
 */
export type SupportUserHook = (
  user: (User & Record<string, unknown>) | null,
  context?: GenericEndpointContext | null,
) => Promise<void>;
