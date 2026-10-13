/**
 * Puts FFmpeg where the packaged app looks for it (build/ffmpeg/<platform>-<arch>/),
 * for the Looks preview and dailies rendering: `node scripts/fetch-ffmpeg.mjs --mac`
 * (Apple silicon and Intel, both shipped in the universal app) or `--win`.
 *
 * The builds are FFmpeg 6.0 static binaries as published by the ffmpeg-static
 * project, pinned by SHA-256: a download that does not match is refused. FFmpeg
 * is run as a separate program and is licensed under the GPL; its licence goes
 * into the app next to it (see docs/ARCHITECTURE.md, "FFmpeg").
 */
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const RELEASE = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0';
const BUILDS = {
  'darwin-arm64': { file: 'ffmpeg-darwin-arm64.gz', sha256: '6be74d6f449889c2e87a75873894f8520cad56c08ac76f2a628d85b0519daaca', binary: 'ffmpeg' },
  'darwin-x64': { file: 'ffmpeg-darwin-x64.gz', sha256: 'a12354fce7eb62361473bbe10d53a1893695babd35869ec8e92e5dfea8d0440b', binary: 'ffmpeg' },
  'win32-x64': { file: 'ffmpeg-win32-x64.gz', sha256: '450d66226c79405c724e821f291cab0911e934bfa9fa2231adcab587f3e07b50', binary: 'ffmpeg.exe' },
};

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'build', 'ffmpeg');
const wanted = process.argv.includes('--win') ? ['win32-x64'] : process.argv.includes('--mac') ? ['darwin-arm64', 'darwin-x64'] : [`${process.platform}-${process.arch}`];

const download = async (url) => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (cause) {
      if (attempt >= 4) throw new Error(`Could not download ${url}: ${cause.message}`);
      await new Promise((resolve) => setTimeout(resolve, 2000 * 2 ** attempt));
    }
  }
};

for (const target of wanted) {
  const build = BUILDS[target];
  if (!build) {
    console.log(`No FFmpeg build is pinned for ${target}; the app will look for ffmpeg on the PATH.`);
    continue;
  }
  const dir = join(root, target);
  const binary = join(dir, build.binary);
  const stamp = join(dir, '.sha256');
  if ((await stat(binary).catch(() => null)) && (await readFile(stamp, 'utf8').catch(() => '')) === build.sha256) {
    console.log(`FFmpeg for ${target}: already in place.`);
    continue;
  }
  const packed = await download(`${RELEASE}/${build.file}`);
  const sha256 = createHash('sha256').update(packed).digest('hex');
  if (sha256 !== build.sha256) throw new Error(`FFmpeg for ${target} does not match its pinned SHA-256 (${sha256}). Refusing it.`);
  await mkdir(dir, { recursive: true });
  await writeFile(binary, gunzipSync(packed));
  await chmod(binary, 0o755);
  await writeFile(join(dir, 'LICENSE.txt'), await download(`${RELEASE}/${target}.LICENSE`));
  await writeFile(join(dir, 'README.txt'), await download(`${RELEASE}/${target}.README`));
  await writeFile(stamp, build.sha256);
  console.log(`FFmpeg for ${target}: ${binary}`);
}
