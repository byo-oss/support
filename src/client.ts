import type { BetterAuthClientPlugin } from "better-auth/client";
import type { CustomerAttachment, TicketAttachment } from "./attachments";
import type { support } from "./index";
import type { SupportFeatures } from "./options";
import type { AgentCounts } from "./queries";
import type { SupportCannedReplyRow } from "./schema";
import type {
  AgentMessage,
  AgentTicket,
  CustomerMessage,
  CustomerTicket,
} from "./serialize";

/**
 * Every endpoint the client calls, with its method. `/support/inbound`
 * (called by the mail relay) and `processSupportDeliveries` (server-only)
 * are not here.
 */
export const supportPathMethods = {
  // customer
  "/support/create-ticket": "POST",
  "/support/my-tickets": "GET",
  "/support/ticket": "GET",
  "/support/reply": "POST",
  "/support/update-mine": "POST",
  "/support/mark-seen": "POST",
  "/support/upload": "POST",
  "/support/attachment": "GET",
  // agent
  "/support/agent/tickets": "GET",
  "/support/agent/ticket": "GET",
  "/support/agent/reply": "POST",
  "/support/agent/update": "POST",
  "/support/agent/merge": "POST",
  "/support/agent/delete": "POST",
  "/support/agent/mark-seen": "POST",
  "/support/agent/tags": "GET",
  "/support/agent/canned": "GET",
  "/support/agent/canned/save": "POST",
  "/support/agent/canned/delete": "POST",
  "/support/agent/upload": "POST",
  "/support/agent/attachment": "GET",
} as const satisfies Record<string, "GET" | "POST">;

export const supportClient = () => {
  return {
    id: "support",
    $InferServerPlugin: {} as ReturnType<typeof support>,
    pathMethods: supportPathMethods,
  } satisfies BetterAuthClientPlugin;
};

// ---------------------------------------------------------------------------
// Response bodies, as the endpoints return them (dates are Date on the
// server; over HTTP see `Wire`)
// ---------------------------------------------------------------------------

/** `createSupportTicket`, `updateMySupportTicket`. */
export type CustomerTicketResponse = { ticket: CustomerTicket };
/** `listMySupportTickets`. */
export type CustomerTicketListResponse = {
  tickets: CustomerTicket[];
  nextCursor: string | null;
  features: Pick<SupportFeatures, "attachments" | "categories">;
};
/** `getSupportTicket`. */
export type CustomerTicketDetailResponse = {
  ticket: CustomerTicket;
  messages: CustomerMessage[];
  attachments: CustomerAttachment[];
};
/** `replyToSupportTicket`. */
export type CustomerMessageResponse = { message: CustomerMessage };
/** `uploadSupportAttachment` (unattached: `messageId` null). */
export type CustomerAttachmentResponse = { attachment: CustomerAttachment };
/** `markSupportTicketSeen`, `markSupportTicketSeenAsAgent`, `deleteSupportCannedReply`. */
export type OkResponse = { ok: true };

/** `listSupportTickets`. */
export type AgentTicketListResponse = {
  tickets: AgentTicket[];
  nextCursor: string | null;
  counts: AgentCounts;
  features: SupportFeatures;
};
/** `getSupportTicketAsAgent`. */
export type AgentTicketDetailResponse = {
  ticket: AgentTicket;
  messages: AgentMessage[];
  attachments: TicketAttachment[];
};
/** `replyAsSupportAgent`. */
export type AgentMessageResponse = { message: AgentMessage };
/** `updateSupportTickets`. */
export type UpdateTicketsResponse = { updated: number };
/** `mergeSupportTickets` (the target). */
export type AgentTicketResponse = { ticket: AgentTicket };
/** `deleteSupportTickets`. */
export type DeleteTicketsResponse = { deleted: number };
/** `listSupportTags`. */
export type TagListResponse = string[];
/** `listSupportCannedReplies`. */
export type CannedReplyListResponse = SupportCannedReplyRow[];
/** `saveSupportCannedReply`. */
export type CannedReplyResponse = { cannedReply: SupportCannedReplyRow };
/** `uploadSupportAttachmentAsAgent` (unattached: `messageId` null). */
export type AgentAttachmentResponse = { attachment: TicketAttachment };

/** A value as it arrives over HTTP: dates may still be ISO strings. */
export type Wire<T> = T extends Date
  ? Date | string
  : T extends (infer U)[]
    ? Wire<U>[]
    : T extends object
      ? { [K in keyof T]: Wire<T[K]> }
      : T;

export type { CustomerAttachment, TicketAttachment } from "./attachments";
export type { SupportFeatures } from "./options";
export type { AgentCounts } from "./queries";
export type {
  SupportCannedReplyRow,
  TicketPriority,
  TicketStatus,
  TicketVisibility,
} from "./schema";
export type {
  AgentMessage,
  AgentTicket,
  CustomerMessage,
  CustomerTicket,
} from "./serialize";
// the access-control statements, here too so shared and browser access files
// don't import the root (which loads the server's mail parsing)
export {
  type SupportAction,
  supportRoles,
  supportStatements,
} from "./statements";
