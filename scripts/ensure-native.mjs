/**
 * Ensure hnswlib-node's native addon (addon.node) is compiled.
 *
 * hnswlib-node ships no prebuilt binary and must compile via node-gyp at install
 * time. pnpm's build-script gating (allowBuilds) is unreliable — a tree that's
 * "already up to date" skips the build, leaving the addon missing and the index
 * failing to load at runtime. This root postinstall closes that gap: it finds
 * the installed package and, if the compiled binding is absent, runs
 * `node-gyp rebuild` there. Idempotent — a no-op once the addon exists.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

// hnswlib-node is a dependency of @knitnode/node, not of the root, so resolve
// from that package's context rather than the repo root.
const require = createRequire(new URL('../packages/node/package.json', import.meta.url));

// hnswlib-node's `exports` blocks resolving package.json directly, so resolve
// the main entry and walk up to the directory that owns package.json.
function packageRoot() {
  let dir = dirname(require.resolve('hnswlib-node'));
  while (!existsSync(join(dir, 'package.json'))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error('could not locate hnswlib-node package root');
    dir = parent;
  }
  return dir;
}

const root = packageRoot();
const addon = join(root, 'build', 'Release', 'addon.node');

if (existsSync(addon)) {
  process.exit(0); // already built
}

console.log(`[knitnode] hnswlib-node addon missing; building in ${root}`);
try {
  execSync('npx node-gyp rebuild', { cwd: root, stdio: 'inherit' });
  console.log('[knitnode] hnswlib-node addon built.');
} catch {
  console.error(
    '[knitnode] Failed to build hnswlib-node. Ensure a C++ toolchain (make, g++/clang, python3) is installed.',
  );
  process.exit(1);
}
