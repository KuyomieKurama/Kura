export type ApiError = Error & { status?: number; code?: string };
export type AuthState = { configured: boolean; authenticated: boolean; role: 'admin' | 'user' | null; csrfToken: string | null; passwordChangeRequired: boolean; oidcEnabled?: boolean };
export type User = { id: string; display_name: string; username: string; role: 'admin' | 'user'; status: 'active' | 'blocked'; created_at: string };

let csrfToken: string | null = null;
let onUnauthenticated: (() => void) | undefined;

function failure(response: Response, body: unknown): ApiError {
  const message = typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'object' && body.error !== null && 'message' in body.error && typeof body.error.message === 'string' ? body.error.message : undefined;
  const code = typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'object' && body.error !== null && 'code' in body.error && typeof body.error.code === 'string' ? body.error.code : undefined;
  return Object.assign(new Error(message ?? 'Request failed'), { status: response.status, code });
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.method && init.method !== 'GET' && csrfToken) headers.set('X-Kura-CSRF', csrfToken);
  if (init.body) headers.set('Content-Type', 'application/json');
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
  testImmichConnection() { return request<{ version: string; supported: boolean }>('/immich/connection/test', { method: 'POST' }); },
  testImmichTransfer(input: { fileName: string; contentBase64: string }) { return request<{ transfer: ImmichTransfer }>('/immich/test-transfer', { method: 'POST', body: JSON.stringify(input) }); },
  immichTransfer(id: string) { return request<{ transfer: ImmichTransfer }>(`/immich/transfers/${id}`); }
};

export type ImmichTransfer = {
  id: string;
  status: string;
  localOriginalRetained: boolean;
  evidence: { serverVersion: string | null; byteLength: number | null; album: string | null } | null;
};
