// System-of-record schema (MySQL 8). The `leads` table mirrors the 34-field
// Affiliate Outreach Board model from airtable/schema.json; Airtable itself is
// a one-time migration source (plan §2.3). PII lives here and only here —
// never in logs or the repo.

import {
  bigint,
  boolean,
  date,
  datetime,
  decimal,
  int,
  json,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
  index,
} from "drizzle-orm/mysql-core";

const id = () => int("id").autoincrement().primaryKey();
const createdAt = () => timestamp("created_at").defaultNow().notNull();
const updatedAt = () => timestamp("updated_at").defaultNow().onUpdateNow().notNull();

export const users = mysqlTable("users", {
  id: id(),
  email: varchar("email", { length: 255 }).notNull(),
  name: varchar("name", { length: 120 }).notNull(),
  role: varchar("role", { length: 16 }).notNull(), // admin | ops | rep | operator
  inviteToken: varchar("invite_token", { length: 64 }),
  invitedAt: datetime("invited_at"),
  activatedAt: datetime("activated_at"),
  passwordHash: varchar("password_hash", { length: 255 }),
  isActive: boolean("is_active").default(true).notNull(),
  sessionEpoch: int("session_epoch").default(0).notNull(), // bumped on logout → revokes old tokens
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("users_email").on(t.email)]);

export const leads = mysqlTable("leads", {
  id: id(),
  airtableId: varchar("airtable_id", { length: 32 }), // provenance from migration
  // Matt McWilliams fields 1–12
  firstName: varchar("first_name", { length: 120 }),
  lastName: varchar("last_name", { length: 120 }),
  email: varchar("email", { length: 255 }),
  emailNormalized: varchar("email_normalized", { length: 255 }),
  emailProvenance: varchar("email_provenance", { length: 24 }), // published_business | scraped | client_provided
  phone: varchar("phone", { length: 40 }),
  socialProfiles: text("social_profiles"),
  websiteUrl: varchar("website_url", { length: 500 }),
  whereFound: varchar("where_found", { length: 500 }), // the SPECIFIC promo URL
  whatTheyPromoted: varchar("what_they_promoted", { length: 255 }),
  otherCreatorCompany: varchar("other_creator_company", { length: 255 }),
  firstReachedOut: date("first_reached_out"),
  lastReachedOut: date("last_reached_out"),
  followUpsSent: int("follow_ups_sent").default(0).notNull(),
  // Qualification
  niche: varchar("niche", { length: 40 }),
  primaryPlatform: varchar("primary_platform", { length: 40 }),
  totalReach: int("total_reach"), // NULL = unverified. Never default to 0 (guardrail).
  reachSourceUrl: varchar("reach_source_url", { length: 500 }), // where verified reach was read
  personCount: int("person_count"), // brand/team divisor for reach-per-person
  affiliationStatus: varchar("affiliation_status", { length: 24 }),
  currentOffer: varchar("current_offer", { length: 255 }),
  entryTier: varchar("entry_tier", { length: 16 }),
  // Workflow
  pitch: varchar("pitch", { length: 64 }),
  status: varchar("status", { length: 24 }), // live-form enum (D8)
  ownerUserId: int("owner_user_id"),
  nextFollowUpDate: date("next_follow_up_date"),
  replyType: varchar("reply_type", { length: 40 }),
  source: varchar("source", { length: 64 }),
  dateAdded: date("date_added"),
  notes: text("notes"),
  conversionRank: int("conversion_rank"),
  rankBand: varchar("rank_band", { length: 4 }),
  needsTriage: boolean("needs_triage").default(false).notNull(),
  subProfile: varchar("sub_profile", { length: 64 }), // SP5 = never cold-contact (L4)
  subProfileConfidence: varchar("sub_profile_confidence", { length: 12 }), // low ⇒ treated as SP5
  personalizationNotes: text("personalization_notes"), // talking points + source URLs
  objectionReason: varchar("objection_reason", { length: 64 }),
  escalationAction: varchar("escalation_action", { length: 64 }),
  contactChannel: varchar("contact_channel", { length: 24 }),
  // Engine bookkeeping
  motion: varchar("motion", { length: 4 }).default("A").notNull(), // A cold | B warm
  geoCountry: varchar("geo_country", { length: 2 }), // automated email is US-only (L5)
  isDead: boolean("is_dead").default(false).notNull(),
  // Enrichment (enrich-personalize job). NULL = never attempted.
  enrichmentStatus: varchar("enrichment_status", { length: 16 }), // pending | enriched | no_match | no_source | unresolvable | failed
  enrichedAt: datetime("enriched_at"),
  enrichmentSourceUrl: varchar("enrichment_source_url", { length: 500 }),
  enrichmentAttempts: int("enrichment_attempts").default(0).notNull(),
  // Sourcing (spec 2026-09-14 §3.3) — null on leads that were not sourced.
  brandFit: varchar("brand_fit", { length: 8 }), // biolinx | aro | both
  sourcingReview: varchar("sourcing_review", { length: 12 }), // pending | accepted | rejected
  sourcingProfileId: int("sourcing_profile_id"),
  sourcingReason: varchar("sourcing_reason", { length: 255 }),
  sourcingSample: json("sourcing_sample"), // [{url,text,postedAt,likes?,views?,comments?}] reviewer + drafter
  sourcingScore: int("sourcing_score"),
  sourcingRejectedReason: varchar("sourcing_rejected_reason", { length: 120 }),
  affiliateCode: varchar("affiliate_code", { length: 64 }), // strongest dedupe key
  competitorId: int("competitor_id"), // the competitor they're signed with; its rate picks the offer
  lastPostAt: datetime("last_post_at"),
  doesLive: boolean("does_live"), // null = not observed; never inferred false
  promoTrackRecord: boolean("promo_track_record"),
  contentOriginal: boolean("content_original"),
  customerioSyncedAt: datetime("customerio_synced_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index("leads_rank").on(t.conversionRank),
  index("leads_status").on(t.status),
  index("leads_email_norm").on(t.emailNormalized),
]);

/** UI-managed configuration + secrets. Secret values are AES-256-GCM encrypted
 *  (the `encrypted` flag says which). Read into process.env at boot. */
export const appSettings = mysqlTable("app_settings", {
  key: varchar("key", { length: 64 }).primaryKey(),
  value: text("value"), // encrypted blob for secrets, plaintext for the rest
  encrypted: boolean("encrypted").default(false).notNull(),
  updatedByUserId: int("updated_by_user_id"),
  updatedAt: updatedAt(),
});

/** platform+handle identity keys → cross-motion dedup (one person, many handles). */
export const leadHandles = mysqlTable("lead_handles", {
  id: id(),
  leadId: int("lead_id").notNull(),
  handleKey: varchar("handle_key", { length: 255 }).notNull(), // "tiktok:username"
  profileUrl: varchar("profile_url", { length: 500 }),
  verifiedAt: datetime("verified_at"), // last time the profile resolved
  createdAt: createdAt(),
}, (t) => [uniqueIndex("handles_key").on(t.handleKey)]);

/** One row per enrichment attempt — the audit trail behind every note. The
 *  bundle is compact (profile fields + item urls + first 300 chars of text);
 *  rows older than 90 days are pruned by the job (PII retention). */
export const leadEnrichments = mysqlTable("lead_enrichments", {
  id: id(),
  leadId: int("lead_id").notNull(),
  platform: varchar("platform", { length: 16 }).notNull(),
  sourceUrl: varchar("source_url", { length: 500 }).notNull(),
  bundle: json("bundle"),
  notes: text("notes"),
  status: varchar("status", { length: 16 }).notNull(), // enriched | no_match | unresolvable | failed
  error: text("error"),
  createdAt: createdAt(),
}, (t) => [index("enrich_lead").on(t.leadId), index("enrich_created").on(t.createdAt)]);

/** An audience the marketing team defines; the lead-ingest job turns it
 *  into Apify searches. Every save is audit-logged. */
export const sourcingProfiles = mysqlTable("sourcing_profiles", {
  id: id(),
  name: varchar("name", { length: 120 }).notNull(),
  active: boolean("active").default(true).notNull(),
  niche: varchar("niche", { length: 40 }).notNull(),
  brandFit: varchar("brand_fit", { length: 8 }).notNull(),
  platforms: json("platforms").notNull(), // ordered: ["tiktok","youtube",...]
  terms: json("terms").notNull(), // { tiktok: string[], ... }
  seedAccounts: json("seed_accounts"), // phase 2, stored now
  followerMin: json("follower_min"), // { tiktok: 5000, ... } null = none
  followerMax: json("follower_max"),
  activityDays: int("activity_days").default(30).notNull(),
  countries: json("countries"), // ["US","CA","GB","AU"]
  language: varchar("language", { length: 8 }).default("en").notNull(),
  matchTerms: json("match_terms"),
  excludeTerms: json("exclude_terms"),
  excludeHandles: json("exclude_handles"),
  dailyCap: int("daily_cap").default(50).notNull(),
  spendCapUsd: decimal("spend_cap_usd", { precision: 6, scale: 2 }).default("2.00").notNull(),
  lastRunAt: datetime("last_run_at"),
  lastRunSummary: json("last_run_summary"),
  createdByUserId: int("created_by_user_id"),
  updatedByUserId: int("updated_by_user_id"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Swipe file posts for the Biolinx affiliate content library, one row per version
 *  (sql/2026-09-15-swipe-posts.sql, docs/integrations/biolinx-content-api.md). */
export const swipePosts = mysqlTable("swipe_posts", {
  id: id(),
  externalId: varchar("external_id", { length: 120 }).notNull(),
  parentId: int("parent_id"),
  version: int("version").default(1).notNull(),
  sourceLeadId: int("source_lead_id"),
  sourcePostUrl: varchar("source_post_url", { length: 500 }),
  sourcePlatform: varchar("source_platform", { length: 16 }),
  sourceStats: json("source_stats"),
  niche: varchar("niche", { length: 40 }),
  biolinxNiche: varchar("biolinx_niche", { length: 16 }).notNull(),
  platform: varchar("platform", { length: 16 }).notNull(),
  format: varchar("format", { length: 12 }).notNull(),
  hookType: varchar("hook_type", { length: 16 }),
  angle: varchar("angle", { length: 255 }),
  hook: varchar("hook", { length: 120 }).notNull(),
  caption: text("caption").notNull(),
  hashtags: json("hashtags"),
  imageText: varchar("image_text", { length: 120 }),
  imageBrief: text("image_brief"),
  imageUrl: varchar("image_url", { length: 1000 }),
  /** The latest "Redo image" note sent to Biolinx, and how many new images were asked for. */
  imageFeedback: text("image_feedback"),
  imageRequests: int("image_requests").default(0).notNull(),
  reviewerFeedback: text("reviewer_feedback"),
  preflight: json("preflight"),
  /** Our side: draft | approved | declined | sending | sent | rejected | duplicate | failed.
   *  Biolinx's own status is biolinx_status. */
  status: varchar("status", { length: 16 }).default("draft").notNull(),
  decidedByUserId: int("decided_by_user_id"),
  decidedAt: datetime("decided_at"),
  sentAt: datetime("sent_at"),
  biolinxId: int("biolinx_id"),
  biolinxStatus: varchar("biolinx_status", { length: 16 }),
  mediaUrl: varchar("media_url", { length: 1000 }),
  mediaId: int("media_id"),
  imageCheck: varchar("image_check", { length: 12 }),
  issues: json("issues"),
  reasons: json("reasons"),
  added: json("added"),
  error: text("error"),
  lastEvent: varchar("last_event", { length: 24 }),
  lastEventAt: datetime("last_event_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("swipe_external_id").on(t.externalId), index("swipe_status").on(t.status)]);

/** Top posts found by the swipe file's own search. Inspiration for swipe posts, used once each. */
export const swipeSources = mysqlTable("swipe_sources", {
  id: id(),
  url: varchar("url", { length: 500 }).notNull(),
  platform: varchar("platform", { length: 16 }).notNull(),
  niche: varchar("niche", { length: 40 }),
  term: varchar("term", { length: 120 }).notNull(),
  authorHandle: varchar("author_handle", { length: 120 }),
  followers: int("followers"),
  views: int("views").notNull(),
  likes: int("likes"),
  comments: int("comments"),
  text: text("text").notNull(),
  postedAt: datetime("posted_at"),
  country: varchar("country", { length: 8 }),
  createdAt: createdAt(),
});

/** Matt's competitor list: their affiliates are the tier-one target. */
export const competitors = mysqlTable("competitors", {
  id: id(),
  name: varchar("name", { length: 120 }).notNull(),
  domains: json("domains"), // ["peptidesciences.com"]
  codePattern: varchar("code_pattern", { length: 120 }), // regex source, or null
  codePrefix: varchar("code_prefix", { length: 24 }), // "PS" → matches PS20, PSJANE
  commissionPct: int("commission_pct"),
  recurring: boolean("recurring"),
  notes: text("notes"),
  active: boolean("active").default(true).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const messages = mysqlTable("messages", {
  id: id(),
  idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
  leadId: int("lead_id").notNull(),
  touchNumber: int("touch_number").notNull(),
  channel: varchar("channel", { length: 24 }).notNull(),
  state: varchar("state", { length: 16 }).notNull(), // drafted…logged | blocked
  draftVariant: varchar("draft_variant", { length: 24 }), // curiosity | rapport | direct
  subject: varchar("subject", { length: 255 }),
  body: text("body"), // verbatim — the log the whole loop depends on
  lintReport: json("lint_report"),
  approvedByUserId: int("approved_by_user_id"),
  approvedAt: datetime("approved_at"),
  sentAt: datetime("sent_at"),
  sentByUserId: int("sent_by_user_id"), // operator confirm for DMs
  externalMessageId: varchar("external_message_id", { length: 255 }), // ESP id
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex("messages_idem").on(t.idempotencyKey),
  index("messages_lead").on(t.leadId),
  index("messages_state").on(t.state),
]);

export const replies = mysqlTable("replies", {
  id: id(),
  leadId: int("lead_id").notNull(),
  channel: varchar("channel", { length: 24 }).notNull(),
  body: text("body"),
  classifiedAs: varchar("classified_as", { length: 24 }), // reply classes incl. opt_out
  classifierConfidence: varchar("classifier_confidence", { length: 12 }),
  handledAt: datetime("handled_at"), // objection engine or human resolution
  handledByUserId: int("handled_by_user_id"),
  receivedAt: datetime("received_at").notNull(),
  createdAt: createdAt(),
}, (t) => [index("replies_lead").on(t.leadId)]);

/** CAN-SPAM suppression list — checked before EVERY email send (L5). */
export const suppressions = mysqlTable("suppressions", {
  id: id(),
  emailNormalized: varchar("email_normalized", { length: 255 }).notNull(),
  reason: varchar("reason", { length: 24 }).notNull(), // opt_out | bounce | complaint | manual
  sourceReplyId: int("source_reply_id"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("suppressions_email").on(t.emailNormalized)]);

/** Motion B rep outreach log (replaces the Airtable Outreach Log). */
export const outreachLog = mysqlTable("outreach_log", {
  id: id(),
  airtableId: varchar("airtable_id", { length: 32 }), // migration provenance
  repUserId: int("rep_user_id"), // attribution = FK once the rep has an account (L6)
  repName: varchar("rep_name", { length: 120 }), // migration fidelity until matched
  prospectName: varchar("prospect_name", { length: 255 }).notNull(),
  aboutThem: text("about_them"),
  channel: varchar("channel", { length: 24 }),
  whatHappened: text("what_happened"),
  status: varchar("status", { length: 24 }).notNull(),
  firstMessageDate: date("first_message_date"),
  lastTouch: date("last_touch"),
  followUpCount: int("follow_up_count").default(0).notNull(),
  nextFollowUpDue: date("next_follow_up_due"), // computed by cadence engine, not a formula
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("outreach_rep").on(t.repUserId)]);

export const signups = mysqlTable("signups", {
  id: id(),
  airtableId: varchar("airtable_id", { length: 32 }),
  recruitedByName: varchar("recruited_by_name", { length: 120 }),
  emailNormalized: varchar("email_normalized", { length: 255 }).notNull(),
  firstName: varchar("first_name", { length: 120 }).notNull(),
  lastName: varchar("last_name", { length: 120 }).notNull(),
  email: varchar("email", { length: 255 }).notNull(),
  streetAddress: varchar("street_address", { length: 255 }),
  city: varchar("city", { length: 120 }),
  state: varchar("state", { length: 64 }),
  zip: varchar("zip", { length: 20 }),
  country: varchar("country", { length: 64 }),
  phone: varchar("phone", { length: 40 }),
  website: varchar("website", { length: 500 }),
  couponWordSuggestion: varchar("coupon_word_suggestion", { length: 64 }),
  recruitedByUserId: int("recruited_by_user_id"), // FK — blank credit is impossible
  leadId: int("lead_id"), // the lead this sign-up came from (outreach flow)
  recruitedByAffiliateId: int("recruited_by_affiliate_id"), // partner-recruited path
  status: varchar("status", { length: 24 }).default("pending_diana").notNull(),
  restrictedSkuAcknowledged: boolean("restricted_sku_acknowledged").default(false).notNull(), // D11
  // Provisioning saga — one column per step so partial failure is visible & compensable
  sagaState: varchar("saga_state", { length: 32 }).default("received").notNull(),
  idevAffiliateId: int("idev_affiliate_id"),
  couponCode: varchar("coupon_code", { length: 40 }),
  couponCreatedInStore: boolean("coupon_created_in_store").default(false).notNull(),
  couponAssignedInIdev: boolean("coupon_assigned_in_idev").default(false).notNull(),
  welcomeEmailSentAt: datetime("welcome_email_sent_at"),
  w9ReceivedAt: datetime("w9_received_at"),
  payoutAuthReceivedAt: datetime("payout_auth_received_at"),
  dianaConfirmedAt: datetime("diana_confirmed_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("signups_email").on(t.emailNormalized)]);

/** A change somebody asked for in Telegram, kept so nothing said in a chat is lost. */
export const tasks = mysqlTable("tasks", {
  id: id(),
  source: varchar("source", { length: 16 }).default("telegram").notNull(),
  chatId: varchar("chat_id", { length: 32 }),
  chatTitle: varchar("chat_title", { length: 160 }),
  askedBy: varchar("asked_by", { length: 120 }),
  askedByUsername: varchar("asked_by_username", { length: 120 }),
  kind: varchar("kind", { length: 16 }).default("change").notNull(),
  title: varchar("title", { length: 200 }).notNull(),
  detail: text("detail"),
  reply: text("reply"),
  /** True when the assistant argued back: the request was risky, or already solved another way. */
  pushedBack: boolean("pushed_back").default(false).notNull(),
  status: varchar("status", { length: 16 }).default("open").notNull(),
  closedByUserId: int("closed_by_user_id"),
  closedAt: datetime("closed_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("tasks_status").on(t.status), index("tasks_created").on(t.createdAt)]);

/** Every Telegram exchange: what was asked, what was answered, whether a model was used. */
export const telegramLog = mysqlTable("telegram_log", {
  id: id(),
  chatId: varchar("chat_id", { length: 32 }).notNull(),
  chatTitle: varchar("chat_title", { length: 160 }),
  askedBy: varchar("asked_by", { length: 120 }),
  updateId: bigint("update_id", { mode: "number" }),
  question: text("question"),
  answer: text("answer"),
  kind: varchar("kind", { length: 16 }),
  taskId: int("task_id"),
  usedAi: boolean("used_ai").default(false).notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("telegram_update").on(t.updateId), index("telegram_chat").on(t.chatId), index("telegram_created").on(t.createdAt)]);

/** Mirror of the iDev roster + our classification + referral expiry tracking. */
export const affiliates = mysqlTable("affiliates", {
  id: id(),
  idevId: int("idev_id").notNull(),
  firstName: varchar("first_name", { length: 120 }),
  lastName: varchar("last_name", { length: 120 }),
  username: varchar("username", { length: 120 }),
  email: varchar("email", { length: 255 }),
  classification: varchar("classification", { length: 16 }).default("unresolved").notNull(), // internal | external | unresolved
  classifiedByUserId: int("classified_by_user_id"),
  /** Their discount code, the thing they actually promote. iDev's API doesn't return it: it comes
   *  from the sign-up we provisioned, or a person pastes it in. Used by the asset generator. */
  couponCode: varchar("coupon_code", { length: 40 }),
  /** Their tracking link, when they use one instead of (or beside) the code. */
  referralLink: varchar("referral_link", { length: 500 }),
  recruiterIdevId: int("recruiter_idev_id"), // referral tree (Phase 0 probe)
  signedUpAt: datetime("signed_up_at"),
  overrideExpiresAt: datetime("override_expires_at"), // signup + 12 months
  overrideExpired: boolean("override_expired").default(false).notNull(),
  firstSeenAt: datetime("first_seen_at").notNull(),
  lastSeenAt: datetime("last_seen_at").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("affiliates_idev").on(t.idevId)]);

export const programStatus = mysqlTable("program_status", {
  id: id(),
  program: varchar("program", { length: 120 }).notNull(), // upsert key
  liveExternalCount: int("live_external_count"), // confirmed-external (never the raw total)
  unresolvedCount: int("unresolved_count").default(0).notNull(), // digest shows a range
  lastSyncedAt: datetime("last_synced_at"), // untouched on failure — staleness stays visible
  unresolvedAccounts: text("unresolved_accounts"), // verbatim ids/names for triage
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("program_name").on(t.program)]);

export const orders = mysqlTable("orders", {
  id: id(),
  stickyOrderId: varchar("sticky_order_id", { length: 64 }).notNull(),
  eventType: varchar("event_type", { length: 32 }).notNull(), // placed | upsell | refunded | cancelled | chargeback
  total: decimal("total", { precision: 10, scale: 2 }),
  couponCode: varchar("coupon_code", { length: 64 }),
  affiliateIdevId: int("affiliate_idev_id"),
  attribution: json("attribution"), // afid/sid/c1-c5/utm_* snapshot
  isTest: boolean("is_test").default(false).notNull(),
  occurredAt: datetime("occurred_at"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("orders_event").on(t.stickyOrderId, t.eventType)]);

export const syncRuns = mysqlTable("sync_runs", {
  id: id(),
  job: varchar("job", { length: 48 }).notNull(),
  status: varchar("status", { length: 16 }).notNull(), // running | ok | failed
  detail: json("detail"),
  startedAt: datetime("started_at").notNull(),
  finishedAt: datetime("finished_at"),
}, (t) => [index("sync_job").on(t.job, t.startedAt)]);

export const gaps = mysqlTable("gaps", {
  id: id(),
  airtableId: varchar("airtable_id", { length: 32 }),
  question: text("question").notNull(),
  askedByUserId: int("asked_by_user_id"),
  askedByName: varchar("asked_by_name", { length: 120 }),
  context: text("context"),
  status: varchar("status", { length: 16 }).default("open").notNull(), // open | answered
  answer: text("answer"),
  answeredByUserId: int("answered_by_user_id"),
  knowledgeVersionId: int("knowledge_version_id"), // the version the answer landed in
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Versioned, hot-reloadable knowledge (FACTS/templates) — the Gaps loop target. */
export const knowledgeVersions = mysqlTable("knowledge_versions", {
  id: id(),
  kind: varchar("kind", { length: 24 }).notNull(), // facts | templates | communities
  version: int("version").notNull(),
  content: json("content").notNull(),
  authoredByUserId: int("authored_by_user_id"),
  note: varchar("note", { length: 500 }),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("knowledge_ver").on(t.kind, t.version)]);

export const config = mysqlTable("config", {
  id: id(),
  key: varchar("key", { length: 64 }).notNull(), // NEVER secrets — env only
  value: json("value").notNull(),
  updatedByUserId: int("updated_by_user_id"),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("config_key").on(t.key)]);

export const auditLog = mysqlTable("audit_log", {
  id: id(),
  actorUserId: int("actor_user_id"), // null = system job
  actorJob: varchar("actor_job", { length: 48 }),
  action: varchar("action", { length: 64 }).notNull(),
  subjectTable: varchar("subject_table", { length: 48 }),
  subjectId: int("subject_id"),
  detail: json("detail"),
  createdAt: createdAt(),
}, (t) => [index("audit_actor").on(t.actorUserId), index("audit_action").on(t.action)]);
