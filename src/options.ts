import type { ByoEventHandler } from "@byo-oss/core";
import type { Mailer } from "@byo-oss/mailer";
import type { InferOptionSchema, Session, User } from "better-auth";
import type { SupportSchema } from "./schema";

export type { Mailer, MailMessage, MailResult } from "@byo-oss/mailer";

const PREFIX = "[@byo-oss/support]";

// ---------------------------------------------------------------------------
// Providers (SPEC §10): exported from the root as named types
// ---------------------------------------------------------------------------

/**
 * Where inbound mail comes from. `receive` authenticates the relay (compare
 * secrets in constant time) and returns the raw RFC 822 bytes, capped at the
 * source's own size limit, or `{ reject: status }` to answer the relay with
 * that HTTP status (401 bad secret, 404 gone for good, 413 too large, 5xx to
 * have the relay retry). Throwing is answered 502, so the relay retries.
 * Test an implementation with `testSupportInboundSource` from
 * `@byo-oss/support/testing`.
 */
export type SupportInboundSource = {
  receive(request: Request): Promise<{ raw: Uint8Array } | { reject: number }>;
};

/**
 * One attachment part of an inbound message, as `parseMessage` returns it
 * and `storeInboundPart` takes it.
 */
export type SupportInboundPart = {
  /** As sent; sanitized when stored. */
  filename: string | null;
  /** As sent; normalized when checked against `allowedTypes`. */
  contentType: string;
  content: Uint8Array;
};

/** What `SupportStorage.get` returns. */
export type SupportStoredObject = {
  body: ReadableStream<Uint8Array>;
  contentType: string;
  size: number;
};

/**
 * Blob storage for attachments. Keys look like
 * `support/<organizationId or "_">/<attachmentId>`. Every method throws to
 * fail the request (nothing is retried); `get` resolves `null` for a missing
 * key and `delete` of a missing key resolves. `deletePrefix` removes every key
 * that starts with the prefix. Test an implementation with
 * `testSupportStorage` from `@byo-oss/support/testing`.
 */
export type SupportStorage = {
  put(input: {
    key: string;
    body: Uint8Array;
    contentType: string;
  }): Promise<void>;
  get(key: string): Promise<SupportStoredObject | null>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
};

// ---------------------------------------------------------------------------
// Access hooks (SPEC §4.3)
// ---------------------------------------------------------------------------

/** A better-auth session as support sees it. `impersonatedBy` comes from the admin plugin. */
export type SupportSession = {
  user: User;
  session: Session & { impersonatedBy?: string | null };
};

export type SupportAuthorizeInput = {
  session: SupportSession;
  headers: Headers;
  /** Always `staffOrganizationId` (possibly undefined), never a ticket's org. */
  organizationId?: string;
  /** e.g. `{ support: ["reply"] }`. */
  permissions: Record<string, string[]>;
};

/**
 * Decides whether a session may perform an agent action. The default looks up
 * the caller's `member` row in `staffOrganizationId` and checks its role with
 * the organization plugin's `hasPermission`; with no staff org it denies.
 */
export type SupportAuthorize = (
  input: SupportAuthorizeInput,
) => boolean | Promise<boolean>;

export type SupportAcceptSessionInput = {
  session: SupportSession;
  headers: Headers;
  kind: "customer" | "agent";
};

/**
 * Called first on every session endpoint; `false` answers 403
 * `SESSION_NOT_ACCEPTED`. The default refuses impersonated sessions.
 */
export type SupportAcceptSession = (
  input: SupportAcceptSessionInput,
) => boolean | Promise<boolean>;

/**
 * Whether a user may be assigned a ticket or @mentioned. The default: a member
 * of `staffOrganizationId` whose role has `support: ["read"]`.
 */
export type SupportIsAgent = (userId: string) => boolean | Promise<boolean>;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type SupportEmailOptions = {
  /** Sender of thread mail, e.g. `"Acme Support <support@acme.com>"`. */
  from: string;
  /** Replies go to `support+<token>@<replyDomain>`; inbound must deliver that domain here. */
  replyDomain: string;
  /** Your app's origin, for the ticket link in mail. */
  appUrl: string;
  /** Path of a ticket in your app. @default (id) => `/support/${id}` */
  ticketPath?: (id: string) => string;
  /** Delay before an agent reply is mailed, in ms; skipped if the requester saw it first. @default 120000 */
  replyDelay?: number;
  /** Mail account holders only at a verified address. @default true */
  requireVerifiedEmail?: boolean;
};

export type SupportInboundOptions = {
  source: SupportInboundSource;
  /** Open a new ticket for mail that doesn't thread. @default true */
  newTickets?: boolean;
  /** Verified email messages stored per sender in the last hour before more are dropped. @default 20 */
  maxPerSenderPerHour?: number;
  /** Unverified messages stored in the last hour (all senders) before more are dropped. @default 100 */
  maxUnverifiedPerHour?: number;
  /** Largest raw message accepted, in bytes. @default 26214400 (25 MiB) */
  maxBytes?: number;
};

export type SupportAttachmentOptions = {
  storage: SupportStorage;
  /** Largest upload, in bytes. @default 10485760 (10 MiB) */
  maxBytes?: number;
  /**
   * Allowed content types. HTML, SVG and XHTML are refused at boot.
   * @default ["image/png","image/jpeg","image/gif","image/webp","application/pdf","text/plain","text/csv","application/zip"]
   */
  allowedTypes?: string[];
};

export type SupportOptions = {
  /** The vendor's staff organization. Agents are members of it whose role has `support` actions. */
  staffOrganizationId?: string;
  /** Replaces the default staff-org permission check (SPEC §4.3). */
  authorize?: SupportAuthorize;
  /** Which sessions may use support endpoints. @default refuse impersonated sessions */
  acceptSession?: SupportAcceptSession;
  /** Who can be assigned or mentioned. @default staff member with `support: ["read"]` */
  isAgent?: SupportIsAgent;
  /** Sends thread mail to requesters. Requires `email`. Unset: no outbound mail and no `supportDelivery` table. */
  mailer?: Mailer;
  /** Required with `mailer` (and with `inbound`). */
  email?: SupportEmailOptions;
  /** Receive email at `/support/inbound`. Requires `email`. */
  inbound?: SupportInboundOptions;
  /** Enable attachments. Unset: no `supportAttachment` table; uploads answer `STORAGE_NOT_CONFIGURED`. */
  attachments?: SupportAttachmentOptions;
  /** Receives every support event (`ByoEvent`). Errors are logged, never thrown. */
  onEvent?: ByoEventHandler;
  /**
   * Clean up after the organization plugin's delete, remove-member and leave
   * endpoints. Turn off to keep history; blobs of a deleted organization are
   * still removed. @default true
   */
  organizationCleanup?: boolean;
  /** Solved tickets are closed by the sweep after this long, in ms. @default 604800000 (7 days) */
  autoCloseAfter?: number;
  /** Attempts per delivery before it is marked failed. @default 5 */
  maxAttempts?: number;
  /** Deliveries per sweep. @default 100 */
  batchSize?: number;
  /** A claimed delivery older than this is presumed dead and retried, in ms. @default 300000 */
  leaseMs?: number;
  /** Tickets per list page, 1 to 50. @default 25 */
  pageSize?: number;
  /** Rename tables and fields (SPEC §2.3). */
  schema?: InferOptionSchema<SupportSchema>;
};

// ---------------------------------------------------------------------------
// Resolved options: what every module receives as `opts`
// ---------------------------------------------------------------------------

export type ResolvedEmailOptions = {
  from: string;
  /** Lowercased. */
  replyDomain: string;
  /** Without a trailing slash. */
  appUrl: string;
  ticketPath: (id: string) => string;
  replyDelay: number;
  requireVerifiedEmail: boolean;
};

export type ResolvedInboundOptions = {
  source: SupportInboundSource;
  newTickets: boolean;
  maxPerSenderPerHour: number;
  maxUnverifiedPerHour: number;
  maxBytes: number;
};

export type ResolvedAttachmentOptions = {
  storage: SupportStorage;
  maxBytes: number;
  /** Lowercased, without parameters. */
  allowedTypes: string[];
};

/** What clients learn is switched on (`features` on both list responses). */
export type SupportFeatures = {
  attachments: boolean;
  merge: boolean;
};

export type ResolvedSupportOptions = {
  staffOrganizationId: string | undefined;
  /** The app's `authorize`, or undefined to use `defaultAuthorize` from `access.ts`. */
  authorize: SupportAuthorize | undefined;
  /** Always set: the app's, or `defaultAcceptSession`. */
  acceptSession: SupportAcceptSession;
  /** The app's `isAgent`, or undefined to use `defaultIsAgent` from `access.ts`. */
  isAgent: SupportIsAgent | undefined;
  mailer: Mailer | undefined;
  /** Set whenever `mailer` is (boot validation pairs them) or `inbound` is. */
  email: ResolvedEmailOptions | undefined;
  inbound: ResolvedInboundOptions | undefined;
  attachments: ResolvedAttachmentOptions | undefined;
  onEvent: ByoEventHandler | undefined;
  organizationCleanup: boolean;
  autoCloseAfter: number;
  maxAttempts: number;
  batchSize: number;
  leaseMs: number;
  pageSize: number;
  /** Unattached uploads older than this are pruned by the sweep, in ms (24 h). */
  uploadTtlMs: number;
  features: SupportFeatures;
  /** The options as given. */
  raw: SupportOptions;
};

/**
 * Whether merging ships. The cut step (K12) flips this one line to `false`,
 * which turns off `features.merge`.
 */
export const MERGE_AVAILABLE = true;

export const DEFAULT_ALLOWED_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/zip",
] as const;

/**
 * Input and paging limits shared by the endpoint, service and UI modules
 * (contracts.md §4), so every module uses the same numbers.
 */
export const SUPPORT_LIMITS = {
  subject: 200,
  body: 50_000,
  cannedTitle: 200,
  cannedBody: 50_000,
  /** `ids` on bulk update and delete. */
  ids: 100,
  attachmentIds: 10,
  mentions: 20,
  q: 200,
  cursor: 4000,
  /** Ids carried in a list cursor. */
  cursorIds: 200,
  tagLength: 50,
  /** Tag rows `listSupportTags` reads at most. */
  tagsListed: 10_000,
  filename: 200,
  /** `mergedIntoId` hops `resolveMergedTicket` follows. */
  mergeHops: 10,
  cannedListed: 200,
} as const;

/** Types a browser would render as a page; refused at boot even if listed. */
export const FORBIDDEN_TYPES = [
  "text/html",
  "image/svg+xml",
  "application/xhtml+xml",
] as const;

/** Lowercase a content type and drop parameters (`Text/Plain; charset=x` → `text/plain`). */
export function normalizeContentType(value: string): string {
  return (value.split(";")[0] ?? "").trim().toLowerCase();
}

/** The default `acceptSession`: refuse sessions an admin is impersonating. */
export const defaultAcceptSession: SupportAcceptSession = ({ session }) =>
  !session.session.impersonatedBy;

const fail = (message: string): never => {
  throw new Error(`${PREFIX} ${message}`);
};

function positiveInteger(
  name: string,
  value: number | undefined,
  fallback: number,
  min = 1,
) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min) {
    fail(`${name} must be an integer of at least ${min}, got ${value}`);
  }
  return value;
}

function requiredString(name: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${name} must be a non-empty string`);
  }
  return (value as string).trim();
}

/**
 * Validates the options (SPEC §2.5) and fills in defaults. Throws an `Error`
 * prefixed `[@byo-oss/support]` on any misconfiguration.
 */
export function resolveOptions(
  options: SupportOptions = {},
): ResolvedSupportOptions {
  if (options.mailer && !options.email) {
    fail("mailer needs email ({ from, replyDomain, appUrl })");
  }
  if (options.email && !options.mailer) {
    fail("email needs mailer: without one no mail is sent");
  }
  if (options.inbound && !options.email) {
    fail(
      "inbound needs email: its replyDomain and from address thread replies and guard against loops",
    );
  }
  if (options.inbound && !options.inbound.source) {
    fail("inbound needs source (rawRelay(...) or wrapsInbound(...))");
  }
  if (options.attachments && !options.attachments.storage) {
    fail("attachments needs storage (s3Storage(...) or memoryStorage())");
  }

  let email: ResolvedEmailOptions | undefined;
  if (options.email) {
    const replyDelay = options.email.replyDelay ?? 120_000;
    if (
      typeof replyDelay !== "number" ||
      Number.isNaN(replyDelay) ||
      replyDelay < 0
    ) {
      fail(`email.replyDelay must be 0 or more, got ${replyDelay}`);
    }
    const replyDomain = requiredString(
      "email.replyDomain",
      options.email.replyDomain,
    ).toLowerCase();
    if (replyDomain.includes("@")) {
      fail(`email.replyDomain is a domain, not an address: ${replyDomain}`);
    }
    email = {
      from: requiredString("email.from", options.email.from),
      replyDomain,
      appUrl: requiredString("email.appUrl", options.email.appUrl).replace(
        /\/+$/,
        "",
      ),
      ticketPath: options.email.ticketPath ?? ((id) => `/support/${id}`),
      replyDelay,
      requireVerifiedEmail: options.email.requireVerifiedEmail ?? true,
    };
  }

  let inbound: ResolvedInboundOptions | undefined;
  if (options.inbound) {
    inbound = {
      source: options.inbound.source,
      newTickets: options.inbound.newTickets ?? true,
      maxPerSenderPerHour: positiveInteger(
        "inbound.maxPerSenderPerHour",
        options.inbound.maxPerSenderPerHour,
        20,
        0,
      ),
      maxUnverifiedPerHour: positiveInteger(
        "inbound.maxUnverifiedPerHour",
        options.inbound.maxUnverifiedPerHour,
        100,
        0,
      ),
      maxBytes: positiveInteger(
        "inbound.maxBytes",
        options.inbound.maxBytes,
        26_214_400,
      ),
    };
  }

  let attachments: ResolvedAttachmentOptions | undefined;
  if (options.attachments) {
    const allowedTypes = (
      options.attachments.allowedTypes ?? [...DEFAULT_ALLOWED_TYPES]
    ).map(normalizeContentType);
    const forbidden = allowedTypes.filter((type) =>
      (FORBIDDEN_TYPES as readonly string[]).includes(type),
    );
    if (forbidden.length > 0) {
      fail(
        `attachments.allowedTypes can't include ${forbidden.join(", ")}: browsers render them as pages`,
      );
    }
    attachments = {
      storage: options.attachments.storage,
      maxBytes: positiveInteger(
        "attachments.maxBytes",
        options.attachments.maxBytes,
        10_485_760,
      ),
      allowedTypes: [...new Set(allowedTypes)],
    };
  }

  const pageSize = positiveInteger("pageSize", options.pageSize, 25);
  if (pageSize > 50) fail(`pageSize can be at most 50, got ${pageSize}`);

  return {
    staffOrganizationId: options.staffOrganizationId,
    authorize: options.authorize,
    acceptSession: options.acceptSession ?? defaultAcceptSession,
    isAgent: options.isAgent,
    mailer: options.mailer,
    email,
    inbound,
    attachments,
    onEvent: options.onEvent,
    organizationCleanup: options.organizationCleanup ?? true,
    autoCloseAfter: positiveInteger(
      "autoCloseAfter",
      options.autoCloseAfter,
      7 * 24 * 60 * 60_000,
      0,
    ),
    maxAttempts: positiveInteger("maxAttempts", options.maxAttempts, 5),
    batchSize: positiveInteger("batchSize", options.batchSize, 100),
    leaseMs: positiveInteger("leaseMs", options.leaseMs, 5 * 60_000),
    pageSize,
    uploadTtlMs: 24 * 60 * 60_000,
    features: { attachments: !!options.attachments, merge: MERGE_AVAILABLE },
    raw: options,
  };
}
