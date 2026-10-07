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
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const electronVersion = require('electron/package.json').version;
const builder = require.resolve('electron-builder/cli.js');
// FFmpeg for the platform being packaged (pinned and checked; see fetch-ffmpeg.mjs).
const platform = process.argv.includes('--win') ? '--win' : '--mac';
const fetched = spawnSync(process.execPath, [fileURLToPath(new URL('./fetch-ffmpeg.mjs', import.meta.url)), platform], { stdio: 'inherit' });
if (fetched.status !== 0) process.exit(fetched.status ?? 1);
const result = spawnSync(process.execPath, [builder, ...process.argv.slice(2), '--publish', 'never', `-c.electronVersion=${electronVersion}`], {
  stdio: 'inherit',
  cwd: new URL('..', import.meta.url),
});
process.exit(result.status ?? 1);
