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

export interface LeadRow {
  id: number;
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
}

export interface LeadDetail {
  lead: Record<string, unknown> & { id: number; personalizationNotes: string | null; notes: string | null };
  messages: Array<{ id: number; channel: string; state: string; body: string | null; sentAt: string | null }>;
  replies: Array<{ id: number; channel: string; body: string | null; classifiedAs: string | null; receivedAt: string }>;
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
  runJob: (job: string) => request<{ ok: true }>(`/api/jobs/${job}`, { method: "POST", body: "{}" }),
  leads: (view: string) => request<LeadRow[]>(`/api/leads?view=${encodeURIComponent(view)}`),
  lead: (id: number) => request<LeadDetail>(`/api/leads/${id}`),
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
  settings: () => request<{ sections: SettingsSection[] }>("/api/settings"),
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

export interface LeadsPage {
  analytics: {
    total: number;
    contacted: number;
    inTalks: number;
    signed: number;
    notContacted: number;
    verifiedReach: number;
    personalized: number;
    dead: number;
  };
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
