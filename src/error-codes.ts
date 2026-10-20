import { defineErrorCodes } from "better-auth";

/**
 * Every error code support answers with. Endpoints throw them with
 * `APIError.from(status, SUPPORT_ERROR_CODES.X)`.
 * `ORGANIZATION_PLUGIN_REQUIRED` is also thrown at boot (from `init`) as a
 * plain `Error` whose message contains the code.
 */
export const SUPPORT_ERROR_CODES = defineErrorCodes({
  ORGANIZATION_PLUGIN_REQUIRED:
    "Support needs the better-auth organization plugin installed",
  TICKET_NOT_FOUND: "Ticket not found",
  NOT_ALLOWED: "You are not allowed to do this",
  SESSION_NOT_ACCEPTED: "This session can't be used for support",
  NOT_A_MEMBER: "You are not a member of this organization",
  TICKET_CLOSED: "This ticket is closed and takes no replies",
  INBOUND_NOT_CONFIGURED: "Inbound email is not configured",
  MERGE_NOT_ALLOWED:
    "Only tickets with the same requester and organization can be merged",
  STORAGE_NOT_CONFIGURED: "Attachments are not configured",
  ATTACHMENT_TOO_LARGE: "The attachment is too large",
  ATTACHMENT_TYPE_NOT_ALLOWED: "This file type is not allowed",
  ATTACHMENT_NOT_USABLE: "One or more attachments can't be used here",
  NOT_AN_AGENT: "That user is not a support agent",
  // added by N04 for codes the module contracts name
  INVALID_STATUS_TRANSITION: "This status change is not allowed",
  INVALID_CURSOR: "Invalid cursor",
  INVALID_TAG:
    "Tags are 1 to 50 characters of lowercase letters, digits, - and _",
  CANNED_REPLY_NOT_FOUND: "Canned reply not found",
  ATTACHMENT_NOT_FOUND: "Attachment not found",
});

export type SupportErrorCode = keyof typeof SUPPORT_ERROR_CODES;
