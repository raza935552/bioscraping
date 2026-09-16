// Thin fetch client. Same-origin via the Vite proxy in dev; cookie-based auth.

export interface Me {
  id: number;
  name: string;
  email: string;
  role: "admin" | "ops" | "rep" | "operator";
}

export interface Dashboard {
  goal: number;
  blackFriday: string;
  daysToBlackFriday: number;
  counts: { external: number; internal: number; unresolved: number };
  approvedTotal: number;
  lastSyncedAt: string | null;
  unresolvedAccounts: string;
  expiredOverrides: number;
  funnel: {
    leadsTotal: number;
    inQueue: number;
    withPersonalization: number;
    sp5Protected: number;
    verifiedReach: number;
    contacted: number;
    replies: number;
    interested: number;
    signups: number;
    signupsPending: number;
  };
  email: { dispatched: number; queued: number; sent: number; blocked: number; suppressions: number };
  syncRuns: Array<{
    id: number;
    job: string;
    status: string;
    detail: Record<string, unknown> | null;
    startedAt: string;
    finishedAt: string | null;
  }>;
}

export interface Affiliate {
  id: number;
  idevId: number;
  firstName: string | null;
  lastName: string | null;
  username: string | null;
  email: string | null;
  classification: "internal" | "external" | "unresolved";
  signedUpAt: string | null;
  suggestion: "team" | "house" | "test" | null;
}

export interface TeamMember {
  id: number;
  name: string;
  email: string;
  role: string;
  activated: boolean;
  inviteToken: string | null;
}

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const merged: RequestInit = { credentials: "same-origin", ...init };
  if (init?.body) merged.headers = { "content-type": "application/json" };
  const res = await fetch(path, merged);
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, body.error ?? `HTTP ${res.status}`);
  return body as T;
}

export interface TemplateDef {
  label: string;
  when: string;
  source: "marketing" | "drafted";
  body: string;
}

export interface OutreachSettings {
  templates: Record<string, string>;
  gaps: Array<{ kind: "pleasure" | "pain" | "curiosity"; text: string }>;
  detailsLink: string;
  aroDetailsLink: string;
  aroCommission: string;
  aroCookie: string;
  checkinDays: number;
}

export interface RenderedMessage {
  templateId: string;
  label: string;
  when: string;
  source: "marketing" | "drafted";
  text: string;
  missing: string[];
  violations: Array<{ rule: string; severity: "block" | "warn"; detail: string }>;
  blocked: boolean;
}

export type FlowStep =
  | { kind: "send"; templateId: string; alternatives: string[]; why: string }
  | { kind: "wait"; since: string; dueAt: string; lastTemplateId: string; why: string }
  | { kind: "signup"; why: string }
  | { kind: "done"; outcome: "not_qualified" | "declined" | "no_reply" | "signed_up"; why: string };

export interface ReplySuggestion {
  kind: "yes" | "tell_me_more" | "no" | "no_info";
  confidence: "high" | "low";
  reason: string;
  source: "keywords" | "ai";
  details: { email: string | null; code: string | null; firstName: string | null; lastName: string | null };
}

export interface OutreachWork {
  counts: { answer: number; checkin: number; new: number; waiting: number; sentToday: number; sentTodayByMe: number };
  next: { leadId: number; bucket: "answer" | "checkin" | "new" } | null;
  waiting: Array<{ leadId: number; name: string; platform: string | null; lastLabel: string; sentAt: string; dueAt: string }>;
  lead: {
    id: number;
    name: string;
    handle: string | null;
    platform: string | null;
    profileUrl: string | null;
    followers: number | null;
    competitor: string | null;
    code: string | null;
    email: string | null;
    country: string | null;
    evidence: { quote: string; url: string | null } | null;
  } | null;
  conversation: Conversation | null;
}

export interface Conversation {
  path: OutreachPath;
  qualified: boolean;
  brand: string | null;
  step: FlowStep;
  history: Array<{ type: "sent" | "reply"; at: string; templateId?: string; label: string; body: string | null; channel: string }>;
  messages: RenderedMessage[];
  gapIndex: number;
  gaps: OutreachSettings["gaps"];
  channels: string[];
}

export interface LeadRow {
  id: number;
  flowStep?: { kind: "send" | "wait" | "signup" | "done"; templateId: string | null; label: string; dueAt: string | null; outcome: string | null };
  outreachPath?: OutreachPath;
  competitorLinked?: string | null;
  competitorRatePct?: number | null;
  email?: string | null;
  rank: number | null;
  band: string | null;
  name: string;
  niche: string | null;
  platform: string | null;
  reach: number | null;
  status: string | null;
  subProfile: string | null;
  needsTriage: boolean;
  isDead: boolean;
  contactChannel: string | null;
  lastReachedOut: string | null;
  followUpsSent: number;
  hasNotes: boolean;
  enrichmentStatus: string | null;
  profileUrl: string | null;
  sourcingScore: number | null;
  sourcingReason: string | null;
  sourcingReview: string | null;
  brandFit: string | null;
  affiliateCode: string | null;
  competitor: string | null;
  lastPostAt: string | null;
  doesLive: boolean | null;
  promoTrackRecord: boolean | null;
  contentOriginal: boolean | null;
  scoreReasons: string[];
  sample: SamplePost[];
  country?: string | null;
  currentOffer?: string | null;
  rejectedReason?: string | null;
  /** Sourced view only: values derived from the profile read. */
  details?: SourcedDetails | null;
}

export interface SourcedDetails {
  handle: string | null;
  niche: string | null;
  bio: string | null;
  avgViews: number | null;
  engagementRate: number | null;
  engagementBasis: "views" | "followers" | null;
  postsLast30: number | null;
  postsRead: number;
  surfaced: { url: string; views: number | null; likes: number | null; comments: number | null } | null;
  isStore: boolean;
  audience: string | null;
  term: string | null;
  daysSinceLastPost: number | null;
  channel: { kind: "competitor" | "hashtag" | "keyword" | "community" | "research" | null; label: string } | null;
  emailSource: { where: "bio" | "post"; url: string | null } | null;
  evidence: { quote: string; url: string | null } | null;
}

export interface SourcedFacets {
  niches: string[];
  countries: string[];
  audiences: string[];
  platforms: string[];
  competitors: Array<{ name: string; n: number }>;
  review: { pending: number; accepted: number; rejected: number };
}

export interface SamplePost {
  url: string;
  text: string;
  postedAt: string | null;
  likes?: number;
  views?: number;
  comments?: number;
}

export interface AudienceProfile {
  id: number;
  name: string;
  active: boolean;
  niche: string;
  brandFit: string;
  platforms: string[];
  terms: Record<string, string[]>;
  followerMin: Record<string, number> | null;
  followerMax: Record<string, number> | null;
  activityDays: number;
  countries: string[] | null;
  language: string;
  matchTerms: string[] | null;
  excludeTerms: string[] | null;
  excludeHandles: string[] | null;
  dailyCap: number;
  spendCapUsd: string;
  lastRunAt: string | null;
  lastRunSummary: Record<string, unknown> | null;
}

export interface Competitor {
  id: number;
  name: string;
  domains: string[] | null;
  codePattern: string | null;
  codePrefix: string | null;
  commissionPct: number | null;
  recurring: boolean | null;
  notes: string | null;
  active: boolean;
}

export interface AudiencesPayload {
  profiles: AudienceProfile[];
  competitors: Competitor[];
  niches: string[];
  platforms: string[];
  defaults: Record<string, unknown>;
}

export interface LeadDetail {
  lead: Record<string, unknown> & { id: number; personalizationNotes: string | null; notes: string | null };
  messages: Array<{ id: number; channel: string; state: string; body: string | null; sentAt: string | null }>;
  replies: Array<{ id: number; channel: string; body: string | null; classifiedAs: string | null; receivedAt: string }>;
  enrichments: Array<{ id: number; platform: string; sourceUrl: string; status: string; error: string | null; createdAt: string }>;
}

export const api = {
  me: () => request<Me>("/api/auth/me"),
  login: (email: string, password: string) =>
    request<{ ok: true; user: Me }>("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  acceptInvite: (token: string, password: string) =>
    request<{ ok: true }>("/api/auth/accept-invite", { method: "POST", body: JSON.stringify({ token, password }) }),
  logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST", body: "{}" }),
  dashboard: () => request<Dashboard>("/api/dashboard"),
  affiliates: () => request<Affiliate[]>("/api/affiliates"),
  classify: (ids: number[], classification: string) =>
    request<{ ok: true; counts: { external: number; internal: number; unresolved: number } }>(
      "/api/affiliates/classify",
      { method: "POST", body: JSON.stringify({ ids, classification }) },
    ),
  team: () => request<TeamMember[]>("/api/team"),
  invite: (name: string, email: string, role: string) =>
    request<{ ok: true; inviteToken: string; invitePath: string }>("/api/team/invite", {
      method: "POST",
      body: JSON.stringify({ name, email, role }),
    }),
  runSync: () => request<{ ok: true }>("/api/jobs/idev-sync", { method: "POST", body: "{}" }),
  runJob: (job: string) => request<{ ok: true; result: unknown }>(`/api/jobs/${job}`, { method: "POST", body: "{}" }),
  leads: (view: string) => request<LeadRow[]>(`/api/leads?view=${encodeURIComponent(view)}`),
  lead: (id: number) => request<LeadDetail>(`/api/leads/${id}`),
  outreach: (id: number, gap?: number | null) => request<Conversation>(`/api/leads/${id}/outreach${gap != null ? `?gap=${gap}` : ""}`),
  outreachSent: (id: number, body: { templateId: string; body: string; channel: string; gapIndex: number | null }) =>
    request<{ ok: true }>(`/api/leads/${id}/outreach/sent`, { method: "POST", body: JSON.stringify(body) }),
  outreachReply: (id: number, body: { kind: string; body: string; channel: string }) =>
    request<{ ok: true }>(`/api/leads/${id}/outreach/reply`, { method: "POST", body: JSON.stringify(body) }),
  outreachSignup: (id: number, body: { firstName: string; lastName: string; email: string; code: string }) =>
    request<{ ok: true; signupId: number }>(`/api/leads/${id}/outreach/signup`, { method: "POST", body: JSON.stringify(body) }),
  outreachWork: (skip: number[], lead?: number | null) =>
    request<OutreachWork>(`/api/outreach/work?skip=${skip.join(",")}${lead ? `&lead=${lead}` : ""}`),
  outreachClassify: (text: string, lastMessageLabel: string | null) =>
    request<ReplySuggestion>("/api/outreach/classify", { method: "POST", body: JSON.stringify({ text, lastMessageLabel }) }),
  outreachSkip: (id: number, reason: "gone" | "not_fit") => request<{ ok: true }>(`/api/leads/${id}/outreach/skip`, { method: "POST", body: JSON.stringify({ reason }) }),
  outreachSettings: () => request<{ settings: OutreachSettings; defaults: Record<string, TemplateDef> }>("/api/outreach/settings"),
  saveOutreachSettings: (settings: OutreachSettings) => request<{ ok: true; settings: OutreachSettings }>("/api/outreach/settings", { method: "PUT", body: JSON.stringify(settings) }),
  previewOutreach: (settings: OutreachSettings) => request<{ previews: Record<string, RenderedMessage> }>("/api/outreach/preview", { method: "POST", body: JSON.stringify({ settings }) }),
  leadsPage: (params: URLSearchParams) => request<LeadsPage>(`/api/leads?${params.toString()}`),
  leadFilters: () => request<{ statuses: string[]; platforms: string[]; subProfiles: string[] }>("/api/leads/filters"),
  emailCampaigns: () => request<EmailCampaigns>("/api/email/campaigns"),
  emailActivity: () => request<EmailActivity>("/api/email/activity"),
  dispatch: (channel: string, cap: number) =>
    request<{ ok: true; result: Record<string, number> }>("/api/outreach/dispatch", {
      method: "POST",
      body: JSON.stringify({ channel, cap }),
    }),
  setupCampaign: () => request<{ campaignId: string; created: boolean }>("/api/email/setup-campaign", { method: "POST", body: "{}" }),
  activity: () => request<ActivityLog>("/api/activity"),
  messages: (state?: string) => request<MessageRow[]>(`/api/messages${state ? `?state=${state}` : ""}`),
  editMessage: (id: number, edits: { body?: string; subject?: string }) =>
    request<{ ok: true }>(`/api/messages/${id}`, { method: "PATCH", body: JSON.stringify(edits) }),
  approveMessage: (id: number, edits?: { body?: string; subject?: string }) =>
    request<{ ok: true; sent: boolean }>(`/api/messages/${id}/approve`, { method: "POST", body: JSON.stringify(edits ?? {}) }),
  markSent: (id: number, contactChannel: string) =>
    request<{ ok: true }>(`/api/messages/${id}/sent`, { method: "POST", body: JSON.stringify({ contactChannel }) }),
  replies: () => request<ReplyRow[]>("/api/replies"),
  signups: () => request<SignupRow[]>("/api/signups"),
  provisionSignup: (id: number) => request<{ sagaState: string; blocked: string | null }>(`/api/signups/${id}/provision`, { method: "POST", body: "{}" }),
  confirmSignup: (id: number) => request<{ ok: true }>(`/api/signups/${id}/confirm`, { method: "POST", body: "{}" }),
  audiences: () => request<AudiencesPayload>("/api/audiences"),
  saveAudience: (id: number | null, body: Record<string, unknown>) =>
    request<{ ok: true; id?: number }>(id ? `/api/audiences/${id}` : "/api/audiences", { method: id ? "PUT" : "POST", body: JSON.stringify(body) }),
  deleteAudience: (id: number) => request<{ ok: true }>(`/api/audiences/${id}`, { method: "DELETE" }),
  runAudience: (id: number) =>
    request<{ ok: true; result: { inserted: number; estimatedCostUsd: number; profiles: Array<Record<string, unknown>> } }>(`/api/audiences/${id}/run`, {
      method: "POST",
      body: "{}",
    }),
  saveCompetitor: (id: number | null, body: Record<string, unknown>) =>
    request<{ ok: true; id?: number }>(id ? `/api/competitors/${id}` : "/api/competitors", { method: id ? "PUT" : "POST", body: JSON.stringify(body) }),
  deleteCompetitor: (id: number) => request<{ ok: true }>(`/api/competitors/${id}`, { method: "DELETE" }),
  reviewBulk: (body: { ids: number[]; decision: "accept" | "reject"; subProfile?: string; reason?: string }) =>
    request<{ ok: true; changed: number; skipped: number; noNiche?: number[] }>("/api/leads/review-bulk", { method: "POST", body: JSON.stringify(body) }),
  competitorSuggestions: () =>
    request<{ suggestions: Array<{ key: string; name: string; domain: string | null; count: number; examples: string[]; firstSeen: string; lastSeen: string }> }>("/api/competitors/suggestions"),
  actOnSuggestion: (key: string, action: "add" | "dismiss", name?: string) =>
    request<{ ok: true; competitorId: number | null }>(`/api/competitors/suggestions/${encodeURIComponent(key)}`, { method: "POST", body: JSON.stringify({ action, name }) }),
  reviewLead: (id: number, body: Record<string, unknown>) => request<{ ok: true }>(`/api/leads/${id}/review`, { method: "POST", body: JSON.stringify(body) }),
  swipe: (status: string) => request<SwipePayload>(`/api/swipe?status=${encodeURIComponent(status)}`),
  swipeGenerate: (count: number) => request<{ ok: true; result: { considered: number; created: number; failed: Array<{ source: string; reason: string }> } }>("/api/swipe/generate", { method: "POST", body: JSON.stringify({ count }) }),
  swipeEdit: (id: number, body: Record<string, unknown>) => request<{ ok: true; preflight: string[] }>(`/api/swipe/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  swipeApprove: (id: number) => request<{ ok: true }>(`/api/swipe/${id}/approve`, { method: "POST" }),
  swipeDecline: (id: number, feedback: string) => request<{ ok: true; newId: number }>(`/api/swipe/${id}/decline`, { method: "POST", body: JSON.stringify({ feedback }) }),
  swipeSend: () => request<{ ok: true; result: { sent: number; accepted: number; duplicates: number; rejected: number; remainingToday: number | null; error?: string } }>("/api/swipe/send", { method: "POST" }),
  swipeFindSources: () => request<{ ok: true; result: { skipped?: string; added: number; estimatedCostUsd: number; tags: Array<{ tag: string; rows: number; kept: number; error?: string }> } }>("/api/swipe/find-sources", { method: "POST" }),
  swipeRedoImage: (id: number, body: { note: string; imageText?: string; imageBrief?: string }) => request<{ ok: true }>(`/api/swipe/${id}/redo-image`, { method: "POST", body: JSON.stringify(body) }),
  swipeRefresh: (id: number) => request<{ ok: true }>(`/api/swipe/${id}/refresh`, { method: "POST" }),
  swipeTestConnection: () => request<{ ok: true; message: string }>("/api/swipe/test-connection", { method: "POST" }),
  settings: () => request<{ sections: SettingsSection[] }>("/api/settings"),
  testAlerts: () => request<{ ok: true }>("/api/settings/alerts/test", { method: "POST" }),
  saveSettings: (section: string, values: Record<string, string>) =>
    request<{ ok: true }>(`/api/settings/${section}`, { method: "PUT", body: JSON.stringify(values) }),
};

export interface SettingsField {
  key: string;
  label: string;
  kind: "secret" | "text" | "number" | "bool";
  help?: string;
  placeholder?: string;
  configured: boolean;
  value?: string;
}
export interface SettingsSection {
  id: string;
  title: string;
  blurb: string;
  fields: SettingsField[];
}

export type OutreachPath = "offer1" | "offer2" | "higher" | "competitor_unnamed" | "unsigned" | "converted";

export interface LeadsPage {
  pathCounts?: Partial<Record<OutreachPath, number>>;
  analytics: {
    total: number;
    contacted: number;
    inTalks: number;
    signed: number;
    notContacted: number;
    verifiedReach: number;
    personalized: number;
    dead: number;
    sourcedPending: number;
  };
  facets?: SourcedFacets | null;
  page: number;
  pageSize: number;
  totalPages: number;
  rows: LeadRow[];
}

export interface EmailCampaigns {
  configured: boolean;
  accounts: number;
  warmedAccounts?: number;
  error?: string;
  campaigns: Array<{ id: string; name: string; status: number }>;
}
export interface EmailActivity {
  email: { total: number; byState: Record<string, number> };
  dm: { total: number; byState: Record<string, number> };
  replies: number;
  suppressions: number;
  recent: Array<{ id: number; leadId: number; channel: string; state: string; subject: string | null; sentAt: string | null }>;
}
export interface ActivityLog {
  audit: Array<{ id: number; actor: string; action: string; subject: string | null; detail: unknown; at: string }>;
  runs: Array<{ id: number; job: string; status: string; detail: unknown; startedAt: string; finishedAt: string | null }>;
}
export interface MessageRow {
  id: number;
  leadId: number;
  leadName: string;
  platform: string | null;
  profileUrl: string | null;
  channel: string;
  state: string;
  subject: string | null;
  body: string | null;
  lintReport: unknown;
  touchNumber: number;
}
export interface ReplyRow {
  id: number;
  leadId: number;
  leadName: string;
  channel: string;
  body: string | null;
  classifiedAs: string | null;
  handledAt: string | null;
  receivedAt: string;
}
export interface SignupRow {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  recruitedByName: string | null;
  status: string;
  sagaState: string;
}

export { ApiError };

export interface SwipePost {
  id: number;
  externalId: string;
  parentId: number | null;
  version: number;
  sourcePostUrl: string | null;
  sourcePlatform: string | null;
  sourceStats: { views?: number; likes?: number | null; comments?: number | null; outlierRatio?: number; basis?: "average" | "followers" | null; text?: string } | null;
  niche: string | null;
  biolinxNiche: string;
  platform: string;
  format: string;
  hookType: string | null;
  angle: string | null;
  hook: string;
  caption: string;
  hashtags: string[] | null;
  imageText: string | null;
  imageBrief: string | null;
  imageUrl: string | null;
  imageFeedback: string | null;
  imageRequests: number;
  reviewerFeedback: string | null;
  preflight: string[] | null;
  status: string;
  decidedAt: string | null;
  sentAt: string | null;
  biolinxId: number | null;
  biolinxStatus: string | null;
  mediaUrl: string | null;
  imageCheck: string | null;
  issues: string[] | null;
  reasons: string[] | null;
  added: string[] | null;
  error: string | null;
  lastEvent: string | null;
  lastEventAt: string | null;
  createdAt: string;
}

export interface SwipePayload {
  sources: { unused: number; total: number; searchDaily: boolean; lastSearch: { at: string; status: string; detail: { added?: number; estimatedCostUsd?: number; skipped?: string } | null } | null };
  connection: { configured: boolean; autoSend: boolean; biolinxMakesImages: boolean; baseUrl: string; callbackUrl: string };
  counts: Record<string, number>;
  posts: SwipePost[];
}
