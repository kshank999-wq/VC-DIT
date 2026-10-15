/**
 * Puts the app's runtime packages (package.json "dependencies", and theirs)
 * into apps/desktop/node_modules, where electron-builder packs them into the
 * installer: `node scripts/stage-deps.mjs`. Run by scripts/package.mjs.
 *
 * This is an npm workspace, so `npm ci` installs every package once, at the
 * repository's root. electron-builder looks only in the app's own folder: with
 * no node_modules there it tries to install them itself and fails, and an app
 * packaged without them cannot open a production (sql.js). The main process
 * keeps its dependencies outside the bundle (electron-vite's externalizeDeps),
 * so these are exactly what the packaged app requires at run time.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = fileURLToPath(new URL('..', import.meta.url));
const target = join(app, 'node_modules');
const staged = new Set();

/** A package's folder, found as Node finds it: node_modules in `from`, then in each folder above. */
const folderOf = (name, from) => {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    // Not the folder being staged into: the real package is further up.
    if (candidate !== join(target, name) && existsSync(join(candidate, 'package.json'))) return candidate;
    if (dirname(dir) === dir) throw new Error(`${name} is not installed. Run npm ci first.`);
  }
};

const stage = (name, from) => {
  if (staged.has(name)) return;
  staged.add(name);
  const source = folderOf(name, from);
  const destination = join(target, name);
  rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, { recursive: true, dereference: true });
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  for (const dependency of Object.keys(manifest.dependencies ?? {})) stage(dependency, source);
};

mkdirSync(target, { recursive: true });
const manifest = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
for (const dependency of Object.keys(manifest.dependencies ?? {})) stage(dependency, app);
console.log(`Staged for packaging: ${[...staged].join(', ') || 'nothing'}`);
