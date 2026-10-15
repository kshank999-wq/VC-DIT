/**
 * Packages the app with electron-builder: `node scripts/package.mjs --win` or
 * `--mac`, plus any electron-builder flags (CI adds signing and notarization).
 * FFmpeg for that platform is fetched first (scripts/fetch-ffmpeg.mjs).
 *
 * A wrapper rather than a bare `electron-builder` script because this is an npm
 * workspace: Electron is hoisted to the repository's node_modules, where
 * electron-builder does not look, so it is told the installed version here.
 * Node rather than shell so the same script runs on the Windows runner.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const electronVersion = require('electron/package.json').version;
const builder = require.resolve('electron-builder/cli.js');
// FFmpeg for the platform being packaged (pinned and checked; see fetch-ffmpeg.mjs).
const platform = process.argv.includes('--win') ? '--win' : '--mac';
const fetched = spawnSync(process.execPath, [fileURLToPath(new URL('./fetch-ffmpeg.mjs', import.meta.url)), platform], { stdio: 'inherit' });
if (fetched.status !== 0) process.exit(fetched.status ?? 1);
// The runtime packages, where electron-builder packs them (see stage-deps.mjs).
const staged = spawnSync(process.execPath, [fileURLToPath(new URL('./stage-deps.mjs', import.meta.url))], { stdio: 'inherit' });
if (staged.status !== 0) process.exit(staged.status ?? 1);
// The Frame.io sign-in comes back to the app on the custom scheme Adobe assigned its client
// (MAIN_VITE_FRAMEIO_REDIRECT_URI, e.g. adobe+1a2b3c://adobeid/<client id>). The installer
// registers the app for that scheme: on macOS it must be in Info.plist, which only
// packaging can write, so the base configuration is extended with it here.
const config = [];
const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(process.env.MAIN_VITE_FRAMEIO_REDIRECT_URI ?? '')?.[1]?.toLowerCase();
if (scheme && scheme !== 'http' && scheme !== 'https') {
  const dir = fileURLToPath(new URL('../out', import.meta.url));
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/electron-builder.frameio.json`;
  writeFileSync(file, JSON.stringify({ extends: 'electron-builder.yml', protocols: [{ name: 'Frame.io sign-in', schemes: [scheme] }] }));
  config.push('--config', file);
}
const result = spawnSync(process.execPath, [builder, ...config, ...process.argv.slice(2), '--publish', 'never', `-c.electronVersion=${electronVersion}`], {
  stdio: 'inherit',
  cwd: new URL('..', import.meta.url),
});
process.exit(result.status ?? 1);
