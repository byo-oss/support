export {
  type SupportFetchClient,
  type SupportPollingOptions,
  type TicketUpdateInput,
  type UseSupportAgentTicketResult,
  type UseSupportCannedRepliesResult,
  type UseSupportQueueOptions,
  type UseSupportQueueResult,
  type UseSupportTicketResult,
  type UseSupportTicketsOptions,
  type UseSupportTicketsResult,
  type UseSupportUploadOptions,
  type UseSupportUploadResult,
  useSupportAgentTicket,
  useSupportCannedReplies,
  useSupportQueue,
  useSupportTicket,
  useSupportTickets,
  useSupportUpload,
  type WireAgentAttachment,
  type WireAgentMessage,
  type WireAgentTicket,
  type WireCannedReply,
  type WireCustomerAttachment,
  type WireCustomerMessage,
  type WireCustomerTicket,
  type WireUploadedAttachment,
} from "./hooks";
export {
  type SupportAgent,
  SupportInbox,
  type SupportInboxProps,
} from "./inbox";
export { defaultInboxLabels, type SupportInboxLabels } from "./inbox/labels";
export {
  defaultLabels,
  formatRelativeTime,
  type SupportLabels,
} from "./labels";
export { SupportWidget, type SupportWidgetProps } from "./widget";
export {
  defaultWidgetLabels,
  type SupportCategoryLabels,
  type SupportWidgetLabels,
} from "./widget/labels";
