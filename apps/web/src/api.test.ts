// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { api } from './api.js';

const response = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
afterEach(() => vi.unstubAllGlobals());

it('adds the csrf token to authenticated writes', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(response({ configured: true, authenticated: true, role: 'admin', csrfToken: 'token', passwordChangeRequired: false })).mockResolvedValueOnce(response(undefined, 204));
  vi.stubGlobal('fetch', fetch); await api.state(); await api.logout();
  expect(fetch.mock.calls[1][1].headers.get('X-Kura-CSRF')).toBe('token');
  expect(fetch.mock.calls[1][1].credentials).toBe('same-origin');
});
it('runs the unauthenticated handler on a 401 response', async () => {
  const handler = vi.fn(); api.setUnauthenticatedHandler(handler); vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ error: { message: 'no' } }, 401)));
  await expect(api.users()).rejects.toMatchObject({ status: 401 }); expect(handler).toHaveBeenCalledOnce();
});
