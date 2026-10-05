/**
 * Packages the app with electron-builder: `node scripts/package.mjs --win` or
 * `--mac`, plus any electron-builder flags (CI adds signing and notarization).
 *
 * A wrapper rather than a bare `electron-builder` script because this is an npm
 * workspace: Electron is hoisted to the repository's node_modules, where
 * electron-builder does not look, so it is told the installed version here.
 * Node rather than shell so the same script runs on the Windows runner.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electronVersion = require('electron/package.json').version;
const builder = require.resolve('electron-builder/cli.js');
const result = spawnSync(process.execPath, [builder, ...process.argv.slice(2), '--publish', 'never', `-c.electronVersion=${electronVersion}`], {
  stdio: 'inherit',
  cwd: new URL('..', import.meta.url),
});
process.exit(result.status ?? 1);
