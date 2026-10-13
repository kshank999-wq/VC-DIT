import { describe, expect, it } from 'vitest';
import { clipKeyOfFile, clipKeyOfRef, rollKey, soundNamesFor } from '../scriptlog/clip-key';
import { groupClips, matchDay, type DayClip } from '../scriptlog/match';
import { parseScriptLog, LOG_TEMPLATE, type LogEntry } from '../scriptlog/parse';
import { parseXml } from '../scriptlog/xml';

describe('clip names', () => {
  it('reduce camera files and logged names to the same key', () => {
    expect(clipKeyOfFile('A015C002_261005_R1AB.mxf')).toBe('A015C002');
    expect(clipKeyOfFile('A015_C002_1005XY_001.R3D')).toBe('A015C002');
    expect(clipKeyOfFile('A015_10051425_C002.braw')).toBe('A015C002');
    expect(clipKeyOfFile('C0001.MP4')).toBeNull();
    for (const written of ['A015C002', 'a015c002', 'A015_C002', 'A15C2', 'A015 C002', 'A015C07'.replace('07', '002')]) expect(clipKeyOfRef(written)).toBe('A015C002');
    expect(clipKeyOfRef('A015C07')).toBe('A015C007');
    expect(clipKeyOfRef('A015C002_261005_R1AB')).toBe('A015C002');
    expect(clipKeyOfRef('wild track')).toBeNull();
    expect(rollKey('a-15')).toBe('A015');
    expect(soundNamesFor('14', 'B', '4')).toEqual(expect.arrayContaining(['14b04', '14bt04', '14b4']));
  });
});

describe('reading a log', () => {
  it('reads a CSV export with a title row, a BOM, quoted notes and circles in the take column', () => {
    const csv = [
      '﻿HALCYON — Day 14 editor log,,,,,',
      'Scene,Setup,Take,Clip Name,Circle (Y/N),VFX,Notes,TC In,TC Out',
      '14,A,1,A015C001,,,,14:02:11:00,14:03:02:12',
      '14,A,2*,A015C002,,,"Good take, ""director\'s pick""",14:05:40:08,14:06:31:20',
      '14,b,3,"A015C003, B010C001",Y,Sky replacement,"Two lines',
      'of notes",14:20:01:00,14:21:10:00',
      ',,,,,,,,',
      'junk,row',
    ].join('\r\n');
    const { format, entries, warnings } = parseScriptLog('day14.csv', csv);
    expect(format).toBe('CSV');
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ scene: '14', setup: 'A', take: '1', clipRefs: ['A015C001'], circle: false, vfx: false, tcIn: '14:02:11:00' });
    expect(entries[1]).toMatchObject({ take: '2', circle: true, notes: 'Good take, "director\'s pick"' });
    expect(entries[2]).toMatchObject({ setup: 'B', clipRefs: ['A015C003', 'B010C001'], circle: true, vfx: true, vfxNote: 'Sky replacement', notes: 'Two lines\nof notes' });
    expect(warnings).toEqual(['Line 8: no take number — skipped.']);
  });

  it('splits a slate column, reads semicolons and tabs, and flags a timecode it cannot read', () => {
    const semicolons = 'Slate;Take;Cam;Roll;TC\n14B;4;A;A015;14:22:10:04\n21A-3;;B;B010;not a tc\n';
    const parsed = parseScriptLog('log.txt', semicolons);
    expect(parsed.entries.map(({ scene, setup, take, cameras, roll }) => ({ scene, setup, take, cameras, roll }))).toEqual([
      { scene: '14', setup: 'B', take: '4', cameras: ['A'], roll: 'A015' },
      { scene: '21', setup: 'A', take: '3', cameras: ['B'], roll: 'B010' },
    ]);
    expect(parsed.warnings).toEqual(['Line 3: timecode "not a tc" not understood — left out.']);

    const tabs = parseScriptLog('log.tsv', 'Sc\tShot\tTk\tSelect\n12\tA\t1\tyes\n');
    expect(tabs).toMatchObject({ format: 'Tab-separated', entries: [{ scene: '12', setup: 'A', take: '1', circle: true }] });
  });

  it('reads an Avid ALE', () => {
    const ale = [
      'Heading',
      'FIELD_DELIM\tTABS',
      'FPS\t23.976',
      '',
      'Column',
      'Name\tTracks\tStart\tEnd\tScene\tTake\tCamroll\tSoundroll\tCircled',
      '',
      'Data',
      'A015C002_261005_R1AB\tV\t14:05:40:08\t14:06:31:20\t14A\t2\tA015\tS014\tY',
      '',
    ].join('\n');
    expect(parseScriptLog('day14.ale', ale)).toMatchObject({
      format: 'ALE',
      entries: [{ scene: '14', setup: 'A', take: '2', clipRefs: ['A015C002_261005_R1AB'], roll: 'A015', soundRoll: 'S014', circle: true, tcOut: '14:06:31:20' }],
    });
  });

  it('reads JSON with nested fields and XML with attributes or child elements', () => {
    const json = JSON.stringify({ production: 'HALCYON', takes: [{ scene: '14', setup: 'A', take: 1, camera: ['A', 'B'], timecode: { in: '14:02:11:00' }, circle: true, vfx: false }] });
    expect(parseScriptLog('log.json', json).entries[0]).toMatchObject({ scene: '14', take: '1', cameras: ['A', 'B'], tcIn: '14:02:11:00', circle: true, vfx: false });

    const xml = `<?xml version="1.0"?>
      <log day="14"><!-- exported -->
        <take scene="14" setup="A" number="ignored" take="1" clip="A015C001"/>
        <take><scene>14</scene><setup>B</setup><take>2</take><notes><![CDATA[Plane <prop> visible]]></notes><vfx>yes</vfx></take>
      </log>`;
    const entries = parseScriptLog('log.xml', xml).entries;
    expect(entries.map((entry) => [entry.scene, entry.setup, entry.take, entry.clipRefs, entry.vfx, entry.notes])).toEqual([
      ['14', 'A', '1', ['A015C001'], false, ''],
      ['14', 'B', '2', [], true, 'Plane <prop> visible'],
    ]);
  });

  it('says what is wrong instead of guessing', () => {
    expect(() => parseScriptLog('log.xlsx', new Uint8Array([0x50, 0x4b, 3, 4]))).toThrow(/Save As → CSV/);
    expect(() => parseScriptLog('log.csv', 'a,b,c\n1,2,3\n')).toThrow(/No header row/);
    expect(() => parseScriptLog('log.json', '{"takes": "none"}')).toThrow(/No list of takes/);
    expect(() => parseXml('<log><take></log>')).toThrow(/line 1/);
    expect(() => parseScriptLog('log.csv', 'Scene,Take\n')).toThrow(/No takes/);
  });

  it('reads its own template', () => {
    const { entries } = parseScriptLog('template.csv', LOG_TEMPLATE);
    expect(entries).toHaveLength(3);
    expect(entries[2]).toMatchObject({ cameras: ['A', 'B'], clipRefs: ['A015C003', 'B010C001'], vfx: true, vfxNote: 'Sky replacement' });
  });
});

const clip = (card: string, fileName: string, at = '2026-10-05T14:06:32', kind: DayClip['kind'] = 'camera'): DayClip => ({
  card,
  path: `CLIPS/${fileName}`,
  fileName,
  kind,
  size: 100,
  mtimeMs: new Date(at).getTime(),
});

const entry = (patch: Partial<LogEntry>): LogEntry => ({
  line: 1,
  scene: '14',
  setup: 'A',
  take: '2',
  slate: '14A',
  cameras: [],
  clipRefs: [],
  roll: '',
  soundRoll: '',
  soundRef: '',
  tcIn: '',
  tcOut: '',
  circle: false,
  print: false,
  vfx: false,
  vfxNote: '',
  notes: '',
  lens: '',
  description: '',
  ...patch,
});

describe('matching the log to the clips', () => {
  const clips = [
    clip('A015', 'A015C001_261005_R1AB.mxf', '2026-10-05T14:03:03'),
    clip('A015', 'A015C001_261005_R1AB.xml', '2026-10-05T14:03:03'),
    clip('A015', 'A015C002_261005_R1AB.mxf', '2026-10-05T14:06:32'),
    clip('A015', 'A015C003_261005_R1AB.mxf', '2026-10-05T14:21:11'),
    clip('888_D14', '14A-T02.WAV', '2026-10-05T14:06:35', 'sound'),
    clip('888_D14', '14A-T03.WAV', '2026-10-05T14:06:35', 'sound'),
  ];

  it('groups a clip with its sidecars', () => {
    expect(groupClips(clips).map((group) => [group.kind, group.key, group.files.length])).toEqual([
      ['camera', 'A015C001', 2],
      ['camera', 'A015C002', 1],
      ['camera', 'A015C003', 1],
      ['sound', '14A-T02', 1],
      ['sound', '14A-T03', 1],
    ]);
  });

  it('matches a logged clip name, and its sound by scene and take', () => {
    const logged = entry({ clipRefs: ['A15C2'] });
    const result = matchDay([logged], clips).get(logged)!;
    expect(result.camera).toEqual([expect.objectContaining({ state: 'matched', clip: { key: 'A015C002', card: 'A015' }, confidence: 100 })]);
    expect(result.sound).toEqual({ key: '14A-T02', card: '888_D14' });
  });

  it('never decides on time alone: roll and timecode give ranked candidates to review', () => {
    const logged = entry({ cameras: ['A'], roll: 'A015', tcIn: '14:05:40:08', tcOut: '14:06:31:20' });
    const [ref] = matchDay([logged], clips).get(logged)!.camera;
    expect(ref).toMatchObject({ state: 'review', clip: null });
    expect(ref!.candidates[0]).toMatchObject({ key: 'A015C002', why: expect.stringMatching(/File time 1s from the logged end TC/) });
    expect(ref!.candidates[0]!.confidence).toBeLessThan(90);
  });

  it('offers neighbours for a clip name not on the cards, and waits for a card not in yet', () => {
    const typo = entry({ clipRefs: ['A015C009'] });
    const missingCard = entry({ take: '3', clipRefs: ['A016C001'] });
    const results = matchDay([typo, missingCard], clips);
    expect(results.get(typo)!.camera[0]).toMatchObject({ state: 'review', candidates: [expect.objectContaining({ key: 'A015C003' }), expect.anything(), expect.anything()] });
    expect(results.get(missingCard)!.camera[0]).toMatchObject({ state: 'unmatched', reason: 'No card A016 has been ingested today yet.' });
    expect(matchDay([entry({})], clips).get(entry({}))).toBeUndefined();
  });

  it('sends both takes to review when two of them claim one clip, and a clip on two cards too', () => {
    const one = entry({ take: '2', clipRefs: ['A015C002'] });
    const two = entry({ take: '3', clipRefs: ['A015C002'] });
    const results = matchDay([one, two], clips);
    expect(results.get(one)!.camera[0]).toMatchObject({ state: 'review', reason: expect.stringMatching(/also logged as Sc 14A T3/) });
    expect(results.get(two)!.camera[0]).toMatchObject({ state: 'review' });

    const copied = [...clips, clip('A015_BACKUP', 'A015C002_261005_R1AB.mxf')];
    const logged = entry({ clipRefs: ['A015C002'] });
    expect(matchDay([logged], copied).get(logged)!.camera[0]).toMatchObject({ state: 'review', candidates: [expect.objectContaining({ card: 'A015' }), expect.objectContaining({ card: 'A015_BACKUP' })] });
  });

  it('matches each camera of a multi-camera row, and says when the log gives nothing to go on', () => {
    const both = entry({ clipRefs: ['A015C003', 'B010C001'], cameras: ['A', 'B'] });
    const nothing = entry({ take: '9' });
    const results = matchDay([both, nothing], clips);
    expect(results.get(both)!.camera.map((ref) => [ref.camera, ref.state])).toEqual([
      ['A', 'matched'],
      ['B', 'unmatched'],
    ]);
    expect(results.get(nothing)!.camera[0]).toMatchObject({ state: 'unmatched', reason: 'The log gives no clip name, roll or timecode for this take.' });
  });

  it("matches by the clip's own timecode once it is read: inside exactly one clip is sure, inside two is a question", () => {
    const at = (h: number, m: number, sec: number) => h * 3600 + m * 60 + sec;
    const coded = [
      { ...clip('A015', 'A015C001_261005_R1AB.mxf'), tc: { start: at(14, 2, 11), end: at(14, 3, 2) } },
      { ...clip('A015', 'A015C002_261005_R1AB.mxf'), tc: { start: at(14, 5, 40), end: at(14, 6, 31) } },
    ];
    const logged = entry({ roll: 'A015', tcIn: '14:05:52:10' });
    expect(matchDay([logged], coded).get(logged)!.camera[0]).toMatchObject({ state: 'matched', clip: { key: 'A015C002', card: 'A015' }, confidence: 95 });

    const overlapping = [...coded, { ...clip('A015', 'A015C003_261005_R1AB.mxf'), tc: { start: at(14, 5, 0), end: at(14, 6, 0) } }];
    const [ref] = matchDay([logged], overlapping).get(logged)!.camera;
    expect(ref).toMatchObject({ state: 'review' });
    expect(ref!.candidates.slice(0, 2).map((candidate) => [candidate.key, candidate.confidence])).toEqual([
      ['A015C002', 70],
      ['A015C003', 70],
    ]);
  });
});
