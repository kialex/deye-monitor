import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Tests require Node.js 22+ (SQLite).');
// Use the bundler shipped with our existing Wrangler development dependency.
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { build } = wranglerRequire('esbuild');
const directory = await mkdtemp(join(tmpdir(), 'deye-tests-'));
try {
  const outfile = join(directory, 'regressions.cjs');
  await build({ entryPoints: ['tests/notification-regressions.ts'], bundle: true, platform: 'node', format: 'cjs', outfile });
  const result = spawnSync(process.execPath, ['--test', outfile], { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
