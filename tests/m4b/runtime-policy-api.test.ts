import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { JobQueue, toQueueLimits, RuntimePolicyRepository } from '../../packages/scheduler/src/index.js';
import { createApiFixture, type ApiFixture } from './api-fixture.js';

describe('admin runtime policy API (M4-B)', () => {
  const fixtures: ApiFixture[] = [];
  const setup = async () => {
    const fixture = await createApiFixture();
    fixtures.push(fixture);
    return fixture;
  };
  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
  });

  it('is admin-only: normal users get 403 for read and write and nothing changes', async () => {
    const fixture = await setup();
    const alice = await fixture.addUser('alice');

    expect((await fixture.call(alice, 'GET', '/api/v1/admin/runtime-policy')).statusCode).toBe(403);
    const write = await fixture.call(alice, 'PUT', '/api/v1/admin/runtime-policy', {
      expectedVersion: 0, policy: { downloads: { maxConcurrentGlobal: 1 } }
    });
    expect(write.statusCode).toBe(403);
    const stored = await fixture.pool.query('SELECT count(*)::int AS count FROM runtime_policy_versions');
    expect(stored.rows[0].count).toBe(0);
  });

  it('returns the plan defaults before anything was saved', async () => {
    const fixture = await setup();
    const response = await fixture.call(fixture.admin, 'GET', '/api/v1/admin/runtime-policy');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      version: 0,
      policy: {
        downloads: { maxConcurrentGlobal: null, maxConcurrentPerUser: null, perAdapter: {}, perUser: {} },
        workers: { downloadSlots: 4, transferSlots: 2, lifecycleReservedSlots: 1 },
        retention: { finishedRunDays: 90 }
      },
      updatedAt: null
    });
    expect(response.json().enforced).toContain('downloads.maxConcurrentGlobal');
    expect(response.json().enforced).not.toContain('workers.downloadSlots');
  });

  it('activates a new version atomically and records the admin and an audit event', async () => {
    const fixture = await setup();
    const alice = await fixture.addUser('alice');
    const saved = await fixture.call(fixture.admin, 'PUT', '/api/v1/admin/runtime-policy', {
      expectedVersion: 0,
      policy: {
        downloads: { maxConcurrentGlobal: 6, maxConcurrentPerUser: 2, perUser: { [alice.userId]: { maxConcurrent: 1 } } },
        retention: { finishedRunDays: 30 }
      }
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ version: 1, updatedBy: fixture.admin.userId });

    const read = await fixture.call(fixture.admin, 'GET', '/api/v1/admin/runtime-policy');
    expect(read.json().policy.downloads).toMatchObject({ maxConcurrentGlobal: 6, maxConcurrentPerUser: 2 });
    expect(read.json().policy.retention.finishedRunDays).toBe(30);

    const audit = await fixture.pool.query("SELECT actor_user_id, target_id FROM audit_events WHERE action = 'runtime_policy.activate'");
    expect(audit.rows).toEqual([{ actor_user_id: fixture.admin.userId, target_id: '1' }]);
  });

  it('answers 409 with the current version when the form is stale', async () => {
    const fixture = await setup();
    await fixture.call(fixture.admin, 'PUT', '/api/v1/admin/runtime-policy', { expectedVersion: 0, policy: {} });
    const stale = await fixture.call(fixture.admin, 'PUT', '/api/v1/admin/runtime-policy', {
      expectedVersion: 0, policy: { downloads: { maxConcurrentGlobal: 9 } }
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: 'VERSION_CONFLICT' }, currentVersion: 1 });
    expect((await fixture.call(fixture.admin, 'GET', '/api/v1/admin/runtime-policy')).json().policy.downloads.maxConcurrentGlobal).toBeNull();
  });

  it.each([
    [{ downloads: { maxConcurrentGlobal: -1 } }],
    [{ downloads: { maxConcurrentPerUser: 'many' } }],
    [{ downloads: { maxBytesPerDayPerUser: 1e300 } }],
    [{ workers: { downloadSlots: 100000 } }],
    [{ retention: { finishedRunDays: 0 } }],
    [{ downloads: { surprise: 1 } }],
    [{ downloads: { perUser: { [randomUUID()]: { maxConcurrent: 1 } } } }]
  ])('rejects invalid values without activating anything: %j', async (policy) => {
    const fixture = await setup();
    const response = await fixture.call(fixture.admin, 'PUT', '/api/v1/admin/runtime-policy', { expectedVersion: 0, policy });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
    expect(response.json().error.problems.length).toBeGreaterThan(0);
    const stored = await fixture.pool.query('SELECT count(*)::int AS count FROM runtime_policy_versions');
    expect(stored.rows[0].count).toBe(0);
  });

  it('requires expectedVersion', async () => {
    const fixture = await setup();
    const response = await fixture.call(fixture.admin, 'PUT', '/api/v1/admin/runtime-policy', { policy: {} });
    expect(response.statusCode).toBe(400);
  });

  it('feeds the queue: the stored limit is what claim enforces', async () => {
    const fixture = await setup();
    const alice = await fixture.addUser('alice');
    await fixture.call(fixture.admin, 'PUT', '/api/v1/admin/runtime-policy', {
      expectedVersion: 0, policy: { downloads: { maxConcurrentGlobal: 0 } }
    });
    const subscription = (await fixture.call(alice, 'POST', '/api/v1/subscriptions', { name: 'A', targetUrl: 'https://a.test' })).json().subscription;
    const queue = new JobQueue(fixture.pool, { clock: fixture.clock });
    await queue.enqueueManual(alice.userId, subscription.id);

    const policy = new RuntimePolicyRepository(fixture.pool);
    const limits = toQueueLimits((await policy.current()).policy);
    expect(await queue.claim({ workerId: 'w', leaseSeconds: 60, limits })).toBeNull();

    await fixture.call(fixture.admin, 'PUT', '/api/v1/admin/runtime-policy', { expectedVersion: 1, policy: {} });
    const open = toQueueLimits((await policy.current()).policy);
    expect(await queue.claim({ workerId: 'w', leaseSeconds: 60, limits: open })).not.toBeNull();
  });
});
