// CRM core barrel — the conversations (WhatsApp inbox) Model/ViewModels.
// Sits beside core/quote / core/tracking / core/store on the CRM side of the
// CRM↔Accounting barrier (enforced in tests/architecture.test.js).

export {
  WA_WINDOW_MS,
  resolveConversations,
  resolveInboxViews,
  conversationMatchesView,
  resolveAssignedUnread,
  resolveThread,
  reconcileOptimistic,
  resolveNewChatContacts,
  resolveLinkCandidates,
  resolveChatTarget,
  resolveReferral,
  resolveOrderMessage,
  isForwardableMessage,
  buildOrderRefsParam,
  parseOrderRefs,
  fillQuickReply,
  isUnsupportedKind,
  isEditUnsupported,
  isMediaPlaceholderKind,
  albumWrapperIds,
  ALBUM_WINDOW_MS,
} from './views/inbox.js';
export {
  IG_WINDOW_MS,
  resolveIgConversations,
  resolveIgThread,
} from './views/igInbox.js';
export {
  splitMessageLinks,
  firstMessageLink,
  resolveLinkPreview,
  resolvePreviewLibrary,
  previewLibraryLink,
} from './views/linkPreview.js';
export {
  GMAIL_BRAND_OTHER,
  GMAIL_BRAND_TABS,
  GMAIL_CAT_INTERNAL,
  GMAIL_CAT_PROVEEDORES,
  GMAIL_CAT_OPERACIONES,
  GMAIL_CAT_MARKETING,
  KNOWN_GMAIL_CATEGORIES,
  DEFAULT_GMAIL_BRAND_RULES,
  senderDomain,
  counterpartEmail,
  classifyBrand,
  isInvoiceEmail,
  parseInvoiceAmount,
  resolveGmailThreads,
  resolveGmailThread,
  resolveGmailInvoices,
  resolveGmailTabCounts,
  resolveGmailAttachments,
  filterGmailThreads,
  filterGmailInvoices,
  filterGmailAttachments,
  resolveInvoiceTrust,
  formatGmailDate,
  senderInitials,
  avatarColorIndex,
  oldestGmailAt,
  olderMailQuery,
  initialOlderCursor,
  olderPageAnchor,
  resolveReplyDraft,
  resolveReplyQuote,
  replySubject,
  splitQuotedHtml,
  splitQuotedText,
  extractCidRefs,
  matchCidAttachments,
  forwardSubject,
  resolveForwardDraft,
  isEmailAddress,
  resolveEmailRecipients,
  buildGmailDraftTurns,
  resolveContactEmailThreads,
} from './views/gmailInbox.js';
export {
  resolveOrderEmailThreads,
  resolveOrderEmailTimeline,
  orderEmailTokens,
  resolveOrderEmailSuggestions,
} from './views/orderEmails.js';
export {
  VAR_SOURCES,
  resolveBroadcastAudience,
  resolveEmailAudience,
  buildBroadcastRecipients,
  fillTemplateBody,
  resolveTemplatePreview,
  templateButtonSuffix,
  campaignButtonBase,
  resolveCampaignButtonParam,
  fillEmailTokens,
  escapeHtml,
  normalizeGroupRows,
  resolveCampaignsList,
  resolveCampaignSentKeys,
  resolveOptOutKeys,
  SCHEDULE_MIN_LEAD_MS,
  validateScheduleAt,
  buildSchedulePayload,
  resolveCampaignSchedule,
  campaignAudienceLabel,
} from './views/campaigns.js';
export {
  WA_FAILURE_REASONS,
  failureReason,
  resolveCampaignFailures,
  resolveCampaignCoverage,
  failureCodeOf,
  isSendablePhone,
  retryableFailureKeys,
  formatFailureReport,
} from './views/campaignFailures.js';
export { resolveChatProducts, inventoryChatCards, buildProductCaption, buildProductCardText, productShareUrl, lsgProductPageUrl, lsgStoreUrl } from './views/productPicker.js';
export {
  resolveGroupsList,
  resolveGroupParticipants,
  resolveGroupAudience,
  buildGroupBroadcastRecipients,
} from './views/groups.js';
export {
  LIFECYCLE_STAGES,
  lifecycleLabel,
  lifecycleTone,
  ACTIVITY_KINDS,
  MANUAL_ACTIVITY_KINDS,
  activityKindLabel,
  resolveContactTimeline,
  resolveTaskQueue,
  taskContactRef,
} from './views/activities.js';
export { resolveContactMilestones } from './views/milestones.js';
export { resolveComposerCommands } from './views/composerCommands.js';
export { buildDraftTurns, resolveDraftContext } from './views/draft.js';
export { resolveTemplateHealth, resolveTemplateGroups } from './views/templates.js';
export { resolveWaHealth } from './views/health.js';
export { waDigits, phoneKey, displayPhone, groupKey, isGroupKey, groupIdFromKey } from '../../lib/phone.js';
