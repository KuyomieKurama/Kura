import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The VM runs the worker from the same image as the API (finding of verifier V3). A real image build is not
// possible in the test environment, so this pins the facts the build depends on.

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const containerfile = readFileSync(join(root, 'deploy', 'Containerfile'), 'utf8');
const workerPackage = JSON.parse(readFileSync(join(root, 'apps', 'worker', 'package.json'), 'utf8')) as { name: string; scripts: Record<string, string> };

describe('deploy/Containerfile: worker in the image', () => {
  it('deploys the production tree of the worker next to the one of the API', () => {
    expect(workerPackage.name).toBe('@kura/worker');
    expect(containerfile).toContain('pnpm --filter @kura/api deploy --prod /production');
    expect(containerfile).toContain(`pnpm --filter ${workerPackage.name} deploy --prod /production-worker`);
    expect(containerfile).toMatch(/COPY --from=build --chown=kura:kura \/production-worker \.\/apps\/worker/);
  });

  it('uses the start file the worker package really builds', () => {
    expect(workerPackage.scripts.start).toBe('node dist/index.js');
    expect(workerPackage.scripts.build).toContain('--outDir dist');
    // deploy/kura-deploy.sh starts the container with this command.
    const script = readFileSync(join(root, 'deploy', 'kura-deploy.sh'), 'utf8');
    expect(script).toContain('node apps/worker/dist/index.js');
  });

  it('keeps the API as the default command and gives the kura user writable work and storage directories', () => {
    expect(containerfile).toContain('CMD ["node", "apps/api/dist/index.js"]');
    expect(containerfile).toContain('chown -R kura:kura /var/lib/kura');
    expect(containerfile).toContain('KURA_WORK_DIR=/var/lib/kura/staging');
    expect(containerfile).toContain('KURA_STORAGE_ROOT=/var/lib/kura/blobstore');
  });
});
