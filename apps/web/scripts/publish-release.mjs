/**
 * Publishes an installer: uploads it to the private dit-releases bucket, records
 * the build, and makes it the current one for its platform. Customers can then
 * download it from their account (through a signed URL, after a license check).
 *
 *   NEXT_PUBLIC_SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
 *   npm run publish:release -w @vcdit/web -- <installer> <windows|macos> <version> ["notes"] ["minimum OS"]
 *
 * Packaging and publishing are separate steps on purpose, as in VC Writer: a
 * build is published only when someone decides it should be.
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const [file, platform, version, notes = '', minimumOs = ''] = process.argv.slice(2);
if (!file || !['windows', 'macos'].includes(platform ?? '') || !version) {
  console.error('usage: publish-release <installer> <windows|macos> <version> ["notes"] ["minimum OS"]');
  process.exit(1);
}
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

const bucket = process.env.RELEASE_BUCKET || 'dit-releases';
const client = createClient(url, key, { auth: { persistSession: false } });
const bytes = readFileSync(file);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const objectKey = `${platform}/${version}/${basename(file)}`;

const upload = await client.storage.from(bucket).upload(objectKey, bytes, {
  upsert: true,
  contentType: platform === 'macos' ? 'application/x-apple-diskimage' : 'application/vnd.microsoft.portable-executable',
});
if (upload.error) throw new Error(`upload: ${upload.error.message}`);

const row = {
  platform,
  version,
  channel: 'stable',
  artifact_key: objectKey,
  artifact_size_bytes: statSync(file).size,
  sha256,
  release_notes: notes,
  minimum_os_version: minimumOs || (platform === 'macos' ? 'macOS 11' : 'Windows 10'),
};
const { data: build, error } = await client
  .from('dit_release_builds')
  .upsert(row, { onConflict: 'platform,channel,version' })
  .select('id')
  .single();
if (error) throw new Error(`record: ${error.message}`);

// One active build per platform: retire the previous, then raise this one.
await client.from('dit_release_builds').update({ active: false }).eq('platform', platform).eq('channel', 'stable').neq('id', build.id);
const raised = await client.from('dit_release_builds').update({ active: true, published_at: new Date().toISOString() }).eq('id', build.id);
if (raised.error) throw new Error(`activate: ${raised.error.message}`);
console.log(`Published ${platform} ${version} (${objectKey}, sha256 ${sha256}).`);
