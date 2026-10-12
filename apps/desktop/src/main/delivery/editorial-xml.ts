import { pathToFileURL } from 'node:url';
import { timecodeLabel } from '../dailies/render-args';
import type { EditorialRow } from '../db/production-db';
import { aleSop, cdlCollection } from '../looks/cdl';

/**
 * The day's camera clips for edit systems that read XML rather than an ALE:
 *
 * - FCPXML (1.10), which Final Cut Pro and DaVinci Resolve import: one event
 *   for the day, each clip with its scene, take, camera roll and note, circled
 *   takes keyworded, and a synced clip where the sound was synced.
 * - Final Cut Pro 7 XML (xmeml 4), which Premiere Pro (and Resolve) import:
 *   bins by scene, each clip a merged clip of picture and the synced sound,
 *   lined up by the sync offset.
 * - An ASC CDL collection (.ccc): each clip's look where the look is a CDL,
 *   its id the clip's name, as colour systems match it.
 *
 * File references point at the copies on the drive the lists are written to,
 * so the edit links to media without being told where it is.
 */

interface Timing {
  num: number;
  den: number;
  /** Frames per second as timecode counts them: 24 for 23.976. */
  base: number;
  ntsc: boolean;
}

const xml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const timingOf = (row: EditorialRow | undefined, frameRate: string): Timing => {
  if (row?.rate && row.rate.den) {
    const { num, den } = row.rate;
    return { num, den, base: Math.round(num / den), ntsc: den === 1001 };
  }
  const fps = Number(/[\d.]+/.exec(frameRate)?.[0] ?? '23.976');
  const ntsc = Math.abs(fps - Math.round(fps)) > 0.001;
  const base = Math.round(fps);
  return ntsc ? { num: base * 1000, den: 1001, base, ntsc } : { num: base, den: 1, base, ntsc };
};

/** The copy on the drive being written to, else the first copy. */
const pick = (paths: string[], root: string | null): string | null => (root ? paths.find((path) => path.startsWith(root)) : undefined) ?? paths[0] ?? null;
const fileUrl = (path: string) => pathToFileURL(path).href;
const name = (row: EditorialRow) => (row.take ? `${row.scene}${row.setup}-${row.take.padStart(2, '0')}` : row.clip);
const frames = (row: EditorialRow, t: Timing) => Math.max(1, Math.round((row.durationSec ?? 0) * (t.num / t.den)));
/** Where the sound starts against picture, in whole frames (positive: after the first frame). */
const shift = (row: EditorialRow) => Math.round(row.syncFrames ?? 0);
const synced = (row: EditorialRow) => row.soundPaths.length > 0;

// ---------------------------------------------------------------- FCPXML

/** A time in FCPXML: a whole number of frames as a rational number of seconds. */
const time = (count: number, t: Timing) => (count === 0 ? '0s' : `${count * t.den}/${t.num}s`);

export const editorialFcpxml = (rows: EditorialRow[], options: { frameRate: string; event: string; root: string | null }): string => {
  const t = timingOf(rows.find((row) => row.rate), options.frameRate);
  const format = `<format id="r1" frameDuration="${time(1, t)}" width="1920" height="1080"/>`;
  const assets: string[] = [];
  const clips: string[] = [];
  rows.forEach((row, index) => {
    const picture = pick(row.paths, options.root);
    if (!picture) return;
    const length = frames(row, t);
    const start = row.tc?.frames ?? 0;
    const tcFormat = row.tc?.dropFrame ? 'DF' : 'NDF';
    const pictureId = `v${index + 1}`;
    assets.push(
      `    <asset id="${pictureId}" name="${xml(row.clip)}" start="${time(start, t)}" duration="${time(length, t)}" hasVideo="1" hasAudio="1" format="r1" audioSources="1" audioChannels="2" audioRate="48000">\n` +
        `      <media-rep kind="original-media" src="${xml(fileUrl(picture))}"/>\n    </asset>`,
    );
    const metadata = [
      ['com.apple.proapps.studio.scene', row.scene],
      ['com.apple.proapps.studio.shot', row.setup],
      ['com.apple.proapps.studio.take', row.take],
      ['com.apple.proapps.studio.cameraName', row.card],
      ['com.apple.proapps.studio.reel', row.roll],
      ['com.apple.proapps.studio.angle', row.clip],
    ]
      .filter(([, value]) => value)
      .map(([key, value]) => `        <md key="${key}" value="${xml(value!)}"/>`);
    // FCPXML's order: the note first, then the clip's own content, then keywords, then metadata.
    const note = row.notes ? [`      <note>${xml(row.notes.replace(/\s+/g, ' ').trim())}</note>`] : [];
    const tags = [
      ...(row.circle ? [`      <keyword start="${time(start, t)}" duration="${time(length, t)}" value="Circled"/>`] : []),
      ...(row.look ? [`      <keyword start="${time(start, t)}" duration="${time(length, t)}" value="Look ${xml(row.look)}"/>`] : []),
      ...(metadata.length ? ['      <metadata>', ...metadata, '      </metadata>'] : []),
    ];
    const sound = synced(row) ? pick(row.soundPaths, options.root) : null;
    if (!sound) {
      clips.push(
        `    <asset-clip ref="${pictureId}" name="${xml(name(row))}" offset="0s" start="${time(start, t)}" duration="${time(length, t)}" format="r1" tcFormat="${tcFormat}">\n${[...note, ...tags].join('\n')}\n    </asset-clip>`,
      );
      return;
    }
    // The sound, lined up by the sync offset, on the lane below picture.
    const soundId = `s${index + 1}`;
    const soundStart = Math.round((row.soundStartSec ?? 0) * (t.num / t.den));
    const soundLength = Math.max(1, Math.round((row.soundDurationSec ?? (row.durationSec ?? 0) + Math.abs(shift(row)) * (t.den / t.num)) * (t.num / t.den)));
    assets.push(
      `    <asset id="${soundId}" name="${xml(row.soundFile)}" start="${time(soundStart, t)}" duration="${time(soundLength, t)}" hasAudio="1" audioSources="1" audioChannels="${row.soundChannels ?? 2}" audioRate="${row.sampleRate ?? 48000}">\n` +
        `      <media-rep kind="original-media" src="${xml(fileUrl(sound))}"/>\n    </asset>`,
    );
    const lead = Math.max(0, shift(row));
    const skip = Math.max(0, -shift(row));
    const heard = Math.max(1, Math.min(length - lead, soundLength - skip));
    clips.push(
      [
        `    <sync-clip name="${xml(name(row))}" offset="0s" start="${time(start, t)}" duration="${time(length, t)}" format="r1" tcFormat="${tcFormat}">`,
        ...note,
        '      <spine>',
        `        <asset-clip ref="${pictureId}" name="${xml(row.clip)}" offset="${time(start, t)}" start="${time(start, t)}" duration="${time(length, t)}" format="r1" tcFormat="${tcFormat}">`,
        `          <asset-clip ref="${soundId}" lane="-1" name="${xml(row.soundFile)}" offset="${time(start + lead, t)}" start="${time(soundStart + skip, t)}" duration="${time(heard, t)}"/>`,
        '        </asset-clip>',
        '      </spine>',
        ...tags,
        '    </sync-clip>',
      ].join('\n'),
    );
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE fcpxml>',
    '<fcpxml version="1.10">',
    '  <resources>',
    `    ${format}`,
    ...assets,
    '  </resources>',
    '  <library>',
    `    <event name="${xml(options.event)}">`,
    ...clips.map((clip) => clip.replace(/^/gm, '  ')),
    '    </event>',
    '  </library>',
    '</fcpxml>',
    '',
  ].join('\n');
};

// ---------------------------------------------------------------- Final Cut Pro 7 XML (Premiere)

const rateXml = (t: Timing, indent: string) => `${indent}<rate><timebase>${t.base}</timebase><ntsc>${t.ntsc ? 'TRUE' : 'FALSE'}</ntsc></rate>`;

export const editorialXmeml = (rows: EditorialRow[], options: { frameRate: string; bin: string; root: string | null }): string => {
  const t = timingOf(rows.find((row) => row.rate), options.frameRate);
  let ids = 0;
  const next = (kind: string) => `${kind}-${(ids += 1)}`;
  const clipXml = (row: EditorialRow): string | null => {
    const picture = pick(row.paths, options.root);
    if (!picture) return null;
    const length = frames(row, t);
    const tcString = row.tc ? timecodeLabel(row.tc.frames, row.tc.base, row.tc.dropFrame) : '00:00:00:00';
    const tcXml = (indent: string, at: { frames: number; string: string; df: boolean }) =>
      [`${indent}<timecode>`, rateXml(t, `${indent}  `), `${indent}  <string>${at.string}</string>`, `${indent}  <frame>${at.frames}</frame>`, `${indent}  <displayformat>${at.df ? 'DF' : 'NDF'}</displayformat>`, `${indent}</timecode>`].join('\n');
    const video = [
      `            <clipitem id="${next('clipitem')}">`,
      `              <name>${xml(row.clip)}</name>`,
      `              <duration>${length}</duration>`,
      rateXml(t, '              '),
      `              <start>0</start><end>${length}</end><in>0</in><out>${length}</out>`,
      `              <file id="${next('file')}">`,
      `                <name>${xml(row.file)}</name>`,
      `                <pathurl>${xml(fileUrl(picture))}</pathurl>`,
      rateXml(t, '                '),
      `                <duration>${length}</duration>`,
      tcXml('                ', { frames: row.tc?.frames ?? 0, string: tcString, df: Boolean(row.tc?.dropFrame) }),
      '                <media><video><samplecharacteristics><width>1920</width><height>1080</height></samplecharacteristics></video><audio><channelcount>2</channelcount></audio></media>',
      '              </file>',
      '              <sourcetrack><mediatype>video</mediatype></sourcetrack>',
      '            </clipitem>',
    ].join('\n');
    const sound = synced(row) ? pick(row.soundPaths, options.root) : null;
    let audio = '';
    if (sound) {
      const lead = Math.max(0, shift(row));
      const skip = Math.max(0, -shift(row));
      const soundLength = Math.max(1, Math.round((row.soundDurationSec ?? (row.durationSec ?? 0) + Math.abs(shift(row)) * (t.den / t.num)) * (t.num / t.den)));
      const end = Math.min(length, lead + soundLength - skip);
      const soundFile = next('file');
      const channels = Math.max(1, Math.min(8, row.soundChannels ?? 2));
      const soundTc = Math.round((row.soundStartSec ?? 0) * t.base);
      audio = Array.from({ length: channels }, (_, channel) =>
        [
          '          <track>',
          `            <clipitem id="${next('clipitem')}">`,
          `              <name>${xml(row.soundFile)}</name>`,
          `              <duration>${soundLength}</duration>`,
          rateXml(t, '              '),
          `              <start>${lead}</start><end>${end}</end><in>${skip}</in><out>${skip + end - lead}</out>`,
          channel === 0
            ? [
                `              <file id="${soundFile}">`,
                `                <name>${xml(row.soundFile)}</name>`,
                `                <pathurl>${xml(fileUrl(sound))}</pathurl>`,
                rateXml(t, '                '),
                `                <duration>${soundLength}</duration>`,
                tcXml('                ', { frames: soundTc, string: timecodeLabel(soundTc, t.base, false), df: false }),
                `                <media><audio><samplecharacteristics><depth>24</depth><samplerate>${row.sampleRate ?? 48000}</samplerate></samplecharacteristics><channelcount>${channels}</channelcount></audio></media>`,
                '              </file>',
              ].join('\n')
            : `              <file id="${soundFile}"/>`,
          `              <sourcetrack><mediatype>audio</mediatype><trackindex>${channel + 1}</trackindex></sourcetrack>`,
          '            </clipitem>',
          '          </track>',
        ].join('\n'),
      ).join('\n');
    }
    return [
      `      <clip id="${next('masterclip')}">`,
      `        <name>${xml(name(row))}</name>`,
      `        <duration>${length}</duration>`,
      rateXml(t, '        '),
      '        <media>',
      '          <video>',
      '            <track>',
      video.replace(/^ {12}/gm, '              '),
      '            </track>',
      '          </video>',
      ...(audio ? ['          <audio>', audio, '          </audio>'] : []),
      '        </media>',
      '        <logginginfo>',
      `          <scene>${xml(row.scene + row.setup)}</scene>`,
      `          <shottake>${xml(row.take)}</shottake>`,
      `          <lognote>${xml(row.notes.replace(/\s+/g, ' ').trim())}</lognote>`,
      `          <good>${row.circle ? 'TRUE' : 'FALSE'}</good>`,
      '        </logginginfo>',
      '        <comments>',
      `          <mastercomment1>${xml(row.card)}</mastercomment1>`,
      `          <mastercomment2>${xml(row.look)}</mastercomment2>`,
      `          <mastercomment3>${xml(row.sync)}</mastercomment3>`,
      ...(row.cdl ? [`          <mastercomment4>${xml(`ASC_SOP ${aleSop(row.cdl)} ASC_SAT ${row.cdl.sat}`)}</mastercomment4>`] : []),
      '        </comments>',
      '      </clip>',
    ].join('\n');
  };

  // Bins by scene; clips no scene names together at the end.
  const scenes = new Map<string, EditorialRow[]>();
  for (const row of rows) scenes.set(row.scene || '', [...(scenes.get(row.scene || '') ?? []), row]);
  const ordered = [...scenes].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b, undefined, { numeric: true })));
  const bins = ordered.map(([scene, list]) => {
    const body = list.map(clipXml).filter((clip): clip is string => clip !== null);
    return ['  <bin>', `    <name>${xml(scene ? `Scene ${scene}` : 'No scene')}</name>`, '    <children>', ...body, '    </children>', '  </bin>'].join('\n');
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE xmeml>',
    '<xmeml version="4">',
    '<bin>',
    `  <name>${xml(options.bin)}</name>`,
    '  <children>',
    ...bins.map((bin) => bin.replace(/^/gm, '  ')),
    '  </children>',
    '</bin>',
    '</xmeml>',
    '',
  ].join('\n');
};

// ---------------------------------------------------------------- ASC CDL

/** Each clip's CDL, its id the clip's name; null when no clip has a CDL look. */
export const editorialCdl = (rows: EditorialRow[]): string | null => {
  const items = rows.filter((row) => row.cdl).map((row) => ({ id: row.clip, description: row.look, cdl: row.cdl! }));
  return items.length ? cdlCollection(items) : null;
};
