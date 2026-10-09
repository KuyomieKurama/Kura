export type ApiError = Error & { status?: number; code?: string; problems?: string[] };
export type AuthState = { configured: boolean; authenticated: boolean; role: 'admin' | 'user' | null; csrfToken: string | null; passwordChangeRequired: boolean; oidcEnabled?: boolean };
export type User = { id: string; display_name: string; username: string; role: 'admin' | 'user'; status: 'active' | 'blocked'; created_at: string };

let csrfToken: string | null = null;
let onUnauthenticated: (() => void) | undefined;

function failure(response: Response, body: unknown): ApiError {
  const message = typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'object' && body.error !== null && 'message' in body.error && typeof body.error.message === 'string' ? body.error.message : undefined;
  const code = typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'object' && body.error !== null && 'code' in body.error && typeof body.error.code === 'string' ? body.error.code : undefined;
  const problems = typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'object' && body.error !== null && 'problems' in body.error && Array.isArray(body.error.problems) ? body.error.problems.filter((item: unknown): item is string => typeof item === 'string') : undefined;
  return Object.assign(new Error(message ?? 'Request failed'), { status: response.status, code, problems });
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.method && init.method !== 'GET' && csrfToken) headers.set('X-Kura-CSRF', csrfToken);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(`/api/v1${path}`, { ...init, headers, credentials: 'same-origin' });
  const body = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  if (response.status === 401) onUnauthenticated?.();
  if (!response.ok) throw failure(response, body);
  return body as T;
}

export const api = {
  setUnauthenticatedHandler(handler: () => void) { onUnauthenticated = handler; },
  async state() { const state = await request<AuthState>('/auth/state'); csrfToken = state.csrfToken; return state; },
  async setup(input: { displayName: string; username: string; password: string; setupToken?: string }) { const response = await request<{ csrfToken: string }>('/auth/setup', { method: 'POST', body: JSON.stringify(input) }); csrfToken = response.csrfToken; return response; },
  async login(input: { username: string; password: string }) { const response = await request<{ csrfToken: string; passwordChangeRequired: boolean }>('/auth/login', { method: 'POST', body: JSON.stringify(input) }); csrfToken = response.csrfToken; return response; },
  async logout() { await request<void>('/auth/logout', { method: 'POST' }); csrfToken = null; },
  users() { return request<{ users: User[] }>('/users'); },
  createUser(input: { displayName: string; username: string; role: 'admin' | 'user'; initialPassword: string }) { return request('/users', { method: 'POST', body: JSON.stringify(input) }); },
  updateUser(id: string, status: 'active' | 'blocked') { return request<void>(`/users/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }); },
  changePassword(input: { currentPassword: string; newPassword: string }) { return request<void>('/auth/change-password', { method: 'POST', body: JSON.stringify(input) }); },
  status() { return Promise.all([fetch('/healthz', { credentials: 'same-origin' }), fetch('/api/v1/status', { credentials: 'same-origin' })]); },
  immichConnection() { return request<{ connection: { serverUrl: string; generation: number; updatedAt: string } | null }>('/immich/connection'); },
  saveImmichConnection(input: { serverUrl: string; apiKey: string }) { return request<void>('/immich/connection', { method: 'PUT', body: JSON.stringify(input) }); },
  deleteImmichConnection() { return request<void>('/immich/connection', { method: 'DELETE' }); },
  testImmichConnection() { return request<{ version: string; supported: boolean; error?: { code: string; message: string }; target?: { host: string; port: number } }>('/immich/connection/test', { method: 'POST' }); },
  testImmichTransfer(input: { fileName: string; contentBase64: string }) { return request<{ transfer: ImmichTransfer }>('/immich/test-transfer', { method: 'POST', body: JSON.stringify(input) }); },
  immichEndpointApprovals() { return request<{ approvals: ImmichEndpointApproval[] }>('/admin/immich/endpoint-approvals'); },
  approveImmichEndpoint(input: { host: string; port: number }) { return request<{ approval: { host: string; port: number } }>('/admin/immich/endpoint-approvals', { method: 'POST', body: JSON.stringify(input) }); },
  revokeImmichEndpoint(input: { host: string; port: number }) { return request<void>(`/admin/immich/endpoint-approvals/${encodeURIComponent(input.host)}/${input.port}`, { method: 'DELETE' }); },
  immichTransfer(id: string) { return request<{ transfer: ImmichTransfer }>(`/immich/transfers/${id}`); },
  credentials() { return request<CredentialOverview>('/credentials'); },
  /** The cookies.txt or the token travels as plain text; the server answers with counts only. */
  saveCredential(platform: CredentialPlatform, text: string) { return request<{ present: true; cookieCount: number; droppedCount: number; earliestExpiry: string | null }>(`/credentials/${platform}`, { method: 'PUT', body: text, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }); },
  deleteCredential(platform: CredentialPlatform) { return request<void>(`/credentials/${platform}`, { method: 'DELETE' }); },
  subscriptions() { return request<{ subscriptions: Subscription[] }>('/subscriptions'); },
  createSubscription(input: SubscriptionInput) { return request<{ subscription: Subscription }>('/subscriptions', { method: 'POST', body: JSON.stringify(input) }); },
  updateSubscription(id: string, input: Partial<SubscriptionInput>) { return request<{ subscription: Subscription }>(`/subscriptions/${id}`, { method: 'PATCH', body: JSON.stringify(input) }); },
  deleteSubscription(id: string) { return request<void>(`/subscriptions/${id}`, { method: 'DELETE' }); },
  pauseSubscription(id: string) { return request<{ subscription: Subscription }>(`/subscriptions/${id}/pause`, { method: 'POST' }); },
  resumeSubscription(id: string) { return request<{ subscription: Subscription }>(`/subscriptions/${id}/resume`, { method: 'POST' }); },
  subscriptionRuns(id: string) { return request<{ runs: SubscriptionRun[] }>(`/subscriptions/${id}/runs`); },
  createSchedule(input: ScheduleInput & { subscriptionId: string }) { return request<{ schedule: Schedule }>('/schedules', { method: 'POST', body: JSON.stringify(input) }); },
  updateSchedule(id: string, input: Partial<ScheduleInput>) { return request<{ schedule: Schedule }>(`/schedules/${id}`, { method: 'PATCH', body: JSON.stringify(input) }); },
  deleteSchedule(id: string) { return request<void>(`/schedules/${id}`, { method: 'DELETE' }); },
  previewSchedule(rule: ScheduleRule, count = 5) { return request<{ entries: PreviewEntry[] }>('/schedules/preview', { method: 'POST', body: JSON.stringify({ rule, count }) }); },
  adapters() { return request<{ adapters: AdapterInfo[] }>('/adapters'); },
  validateSource(url: string) { return request<SourceValidation>('/sources/validate', { method: 'POST', body: JSON.stringify({ url }) }); },
  validateSubscription(id: string) { return request<{ targetState: Subscription['targetState']; validation: SourceValidation }>(`/subscriptions/${id}/validate`, { method: 'POST' }); },
  runSubscriptionNow(id: string) { return request<{ coalesced: boolean; run: { id: string; state: string; runAfter: string } }>(`/subscriptions/${id}/run-now`, { method: 'POST' }); },
  syncState(id: string) { return request<{ syncState: SyncState | null }>(`/subscriptions/${id}/sync-state`); },
  history() { return request<{ runs: HistoryRun[]; posts: HistoryPost[] }>('/history'); },
  killSwitches() { return request<{ killSwitches: KillSwitch[] }>('/admin/adapter-kill-switches'); },
  setKillSwitch(input: { adapterId: string; adapterVersion?: string; sourceType?: string; reason: string }) { return request<{ killSwitch: KillSwitch }>('/admin/adapter-kill-switches', { method: 'POST', body: JSON.stringify(input) }); },
  liftKillSwitch(id: string) { return request<void>(`/admin/adapter-kill-switches/${id}`, { method: 'DELETE' }); },
  runtimePolicy() { return request<RuntimePolicyResponse>('/admin/runtime-policy'); },
  saveRuntimePolicy(expectedVersion: number, policy: RuntimePolicy) { return request<RuntimePolicyResponse>('/admin/runtime-policy', { method: 'PUT', body: JSON.stringify({ expectedVersion, policy }) }); }
};

export type ScheduleRule =
  | { kind: 'cron'; expression: string; timeZone: string; gapPolicy: 'skip' | 'run_after_gap' }
  | { kind: 'interval'; everySeconds: number; anchorUtc?: string; timeZone: string }
  | { kind: 'once'; atUtc: string; timeZone: string };
export type ScheduleInput = { rule: ScheduleRule; jitterMaxSeconds?: number; enabled?: boolean };
export type Schedule = { id: string; subscriptionId: string; version: number; rule: ScheduleRule; jitterMaxSeconds: number; enabled: boolean; nextDueAt: string | null };
export type Subscription = {
  id: string;
  name: string;
  targetUrl: string | null;
  platformHint: string | null;
  targetState: 'unvalidated' | 'valid' | 'invalid';
  status: 'active' | 'paused';
  schedules?: Schedule[];
};
export type SubscriptionInput = { name: string; targetUrl: string; platformHint?: string | null };
export type SubscriptionRun = { id: string; triggerKind: 'schedule' | 'manual'; state: string; scheduledFor: string; attempts: number; maxAttempts: number; lastError: string | null; finishedAt: string | null };
export type PreviewEntry = { scheduledForUtc: string | null; localPlanTime: string | null; timeZone: string; utcOffset: string | null; status: 'regular' | 'overlap_first' | 'gap_shifted' | 'gap_skipped' | 'coalesced' };
export type ConcurrencyEntry = { maxConcurrent: number | null };
export type RuntimePolicy = {
  downloads: {
    maxConcurrentGlobal: number | null;
    maxConcurrentPerUser: number | null;
    maxConcurrentPerSourceAccount: number | null;
    maxDownloadsPerDayPerUser: number | null;
    maxBytesPerDayPerUser: number | null;
    bandwidthBytesPerSecond: number | null;
    perAdapter: Record<string, ConcurrencyEntry>;
    perUser: Record<string, ConcurrencyEntry>;
  };
  workers: { downloadSlots: number; transferSlots: number; lifecycleReservedSlots: number };
  retention: { finishedRunDays: number };
};
export type RuntimePolicyResponse = { version: number; policy: RuntimePolicy; updatedAt: string | null; enforced: string[] };

export type CredentialPlatform = 'instagram' | 'patreon' | 'pixiv' | 'youtube';
/** The stored login of one platform. Never carries content: only counts, dates and the result of the last use. */
export type CredentialStatus =
  | { platform: CredentialPlatform; kind: 'cookies' | 'token'; present: false }
  | {
    platform: CredentialPlatform; kind: 'cookies' | 'token'; present: true; cookieCount: number; earliestExpiry: string | null;
    expired: boolean; updatedAt: string; lastUsedAt: string | null; lastResult: 'ok' | 'auth_required' | 'unknown';
  };
export type CredentialOverview = { secretKeyConfigured: boolean; credentials: CredentialStatus[] };

export type ImmichEndpointApproval = { host: string; port: number; approvedAt: string };
export type ImmichTransfer = {
  id: string;
  status: string;
  localOriginalRetained: boolean;
  evidence: { serverVersion: string | null; byteLength: number | null; album: string | null } | null;
};

export type AdapterCapabilities = {
  singlePost: boolean; creatorFeed: boolean; images: boolean; videos: boolean; pagination: boolean; resume: boolean;
  pageSnapshot: boolean; qualityVariants: boolean; authKind: string; authLabel: string; presets: string[];
};
export type Availability = 'available' | 'unavailable' | 'unknown';
export type SourceValidation =
  | {
    supported: true; canonicalUrl: string; platform: string; platformLabel: string; targetKind: string;
    adapter: { id: string; label: string; availability: Availability; version: string | null };
    capabilities: AdapterCapabilities; runnable: boolean; notices: string[];
    /** Platforms with a stored login: whether this user stored one, and whether the target needs a login in practice. */
    credentials?: { platform: CredentialPlatform; stored: boolean; loginNeeded: boolean };
  }
  | { supported: false; code: string; message: string; notices: string[] };
export type AdapterInfo = {
  id: string; label: string; version: string | null; sourceTypes: { id: string; label: string; capabilities?: AdapterCapabilities; /** The kinds of address this adapter takes for the platform, as German phrases. */ addressKinds?: string[] }[];
  capabilities: AdapterCapabilities; availability: Availability; reasonCode: string | null; message: string | null;
  checkedAt: string | null; disabledByAdministrator: boolean;
};
export type KillSwitch = { id: string; adapterId: string; adapterVersion: string | null; sourceType: string | null; reason: string; createdAt: string };
export type SyncState = { lastSeenPostId: string | null; lastSeenRevisionKey: string | null; lastSeenAt: string | null; checkedThrough: string | null };
export type HistoryRun = {
  id: string; subscriptionId: string; subscriptionName: string; sourceUrl: string | null; triggerKind: 'schedule' | 'manual';
  platform: string | null; adapterId: string | null; adapterVersion: string | null; state: string; errorCode: string | null;
  errorMessage: string | null; postsFound: number; postsSkipped: number; assetsStored: number; assetsFailed: number;
  bytesStored: number; startedAt: string; finishedAt: string | null;
};
export type HistoryAsset = {
  id: string; index: number; sourceAssetId: string; originalName: string; mediaType: string; state: string; attempts: number;
  byteSize: number | null; sha256: string | null; errorCode: string | null; errorMessage: string | null; storedAt: string | null;
  localOriginalRetained: boolean;
  handover: {
    state: string; at: string | null; transferId: string | null; transferStatus: string | null;
    evidence: { serverVersion: string | null; byteLength: number | null; album: string | null; verifiedAt: string } | null;
  };
};
export type HistoryPost = {
  id: string; subscriptionId: string; subscriptionName: string; platform: string; adapterId: string; creatorId: string;
  creatorName: string | null; platformPostId: string; title: string | null; sourceUrl: string | null; state: string;
  discoveryComplete: boolean; discoveredAt: string; completedAt: string | null; assets: HistoryAsset[];
};
