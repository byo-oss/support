import type { ByoPlugin } from "@byo-oss/core";
import type { BetterAuthPlugin } from "better-auth";
import { mergeSchema } from "better-auth/db";
import { SUPPORT_ERROR_CODES } from "./error-codes";
import {
  createByoHooks,
  organizationHooksAfter,
  userDeleteHook,
} from "./lifecycle";
import { userLinkHooks } from "./link";
import { resolveOptions, type SupportOptions } from "./options";
import { adminEndpoints } from "./routes/admin";
import { agentEndpoints } from "./routes/agent";
import { attachmentEndpoints } from "./routes/attachments";
import { customerEndpoints } from "./routes/customer";
import { inboundEndpoints } from "./routes/inbound";
import { mergeEndpoints } from "./routes/merge";
import { sweepEndpoints } from "./routes/sweep";
import { buildSchema } from "./schema";

/**
 * Customer support for better-auth: tickets, replies, internal notes, canned
 * replies, attachments and email, in your own database. Requires the
 * organization plugin.
 */
export const support = (options: SupportOptions = {}) => {
  const opts = resolveOptions(options);
  return {
    id: "support",
    schema: mergeSchema(buildSchema(options), options.schema),
    endpoints: {
      ...customerEndpoints(opts),
      ...agentEndpoints(opts),
      ...adminEndpoints(opts),
      ...mergeEndpoints(opts),
      ...attachmentEndpoints(opts),
      ...sweepEndpoints(opts),
      ...inboundEndpoints(opts),
    },
    init: (context) => {
      if (
        !context.options.plugins?.some((plugin) => plugin.id === "organization")
      ) {
        throw new Error(
          `[@byo-oss/support] ${SUPPORT_ERROR_CODES.ORGANIZATION_PLUGIN_REQUIRED.code}: add organization() to plugins; support's schema and staff model need it`,
        );
      }
      // request-time misuse (a staffOrganizationId function that throws)
      // goes to better-auth's logger
      opts.logger = context.logger;
      // the option as given: `null` (no agents on purpose) and a function
      // (resolved per request) never warn
      const staff = options.staffOrganizationId;
      if ((staff === undefined || staff === "") && !opts.authorize) {
        context.logger.warn(
          "[@byo-oss/support] no staffOrganizationId and no authorize: every agent endpoint will deny (pass staffOrganizationId: null to run without agents)",
        );
      }
      const link = userLinkHooks(context, opts);
      return {
        options: {
          databaseHooks: {
            user: {
              create: { after: link.create.after },
              update: { after: link.update.after },
              delete: { after: userDeleteHook(context, opts) },
            },
          },
        },
      };
    },
    hooks: {
      after: organizationHooksAfter(opts),
    },
    $ERROR_CODES: SUPPORT_ERROR_CODES,
    // resolved options: `authRuntime` reads them for the exported functions
    options: opts,
    byo: createByoHooks(opts),
  } satisfies ByoPlugin<BetterAuthPlugin>;
};

export type SupportPlugin = ReturnType<typeof support>;

export type {
  AuthWithContext,
  MemberRow,
  UserSummary,
} from "./adapter";
export type {
  CustomerAttachment,
  InboundPartDropReason,
  TicketAttachment,
} from "./attachments";
export type { SupportSweepResult } from "./delivery";
export { SUPPORT_ERROR_CODES, type SupportErrorCode } from "./error-codes";
export {
  SUPPORT_EVENT_TYPES,
  type SupportEvent,
  type SupportEventType,
} from "./events";
export {
  type ExportedAttachment,
  type ExportedCannedReply,
  type ExportedDelivery,
  type ExportedMessage,
  type ExportedTicket,
  type ExportSupportDataOptions,
  exportSupportData,
  type SupportExportPage,
} from "./export";
export { type RawRelayOptions, rawRelay } from "./inbound/raw-relay";
export type { DkimResolver } from "./inbound/verify";
export {
  deleteMemberData,
  deleteOrganizationData,
  deleteSupportRequesterData,
} from "./lifecycle";
export { linkSupportRequester } from "./link";
export type {
  Mailer,
  MailMessage,
  MailResult,
  SupportAcceptSession,
  SupportAcceptSessionInput,
  SupportAttachmentOptions,
  SupportAuthorize,
  SupportAuthorizeInput,
  SupportEmailOptions,
  SupportFeatures,
  SupportInboundOptions,
  SupportInboundPart,
  SupportInboundSource,
  SupportIsAgent,
  SupportOptions,
  SupportSession,
  SupportStaffOrganizationId,
  SupportStorage,
  SupportStoredObject,
} from "./options";
export type { AgentCounts } from "./queries";
export type {
  AuthorType,
  DeliveryStatus,
  MessageKind,
  SupportAttachmentRow,
  SupportCannedReplyRow,
  SupportCounterRow,
  SupportDeliveryRow,
  SupportEventData,
  SupportMessageRow,
  SupportTicketRow,
  SupportTicketTagRow,
  TicketChannel,
  TicketPriority,
  TicketRating,
  TicketStatus,
  TicketVisibility,
} from "./schema";
export type {
  AgentMessage,
  AgentTicket,
  CustomerMessage,
  CustomerTicket,
  PublicAuthor,
} from "./serialize";
export {
  type SupportAction,
  supportRoles,
  supportStatements,
} from "./statements";
