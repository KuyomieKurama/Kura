// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App.js';

afterEach(() => vi.unstubAllGlobals());

it('shows service and migration status', async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'ok' }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ version: '0.1.0', database: 'ok', migrations: { appliedCount: 2, latestVersion: '002_core' } }) });
  vi.stubGlobal('fetch', fetch);
  render(<App />);
  expect(await screen.findByText('Erreichbar')).toBeInTheDocument();
  expect(screen.getByText('Angewendete Migrationen: 2')).toBeInTheDocument();
  expect(screen.getByText('Letzte Version: 002_core')).toBeInTheDocument();
});
