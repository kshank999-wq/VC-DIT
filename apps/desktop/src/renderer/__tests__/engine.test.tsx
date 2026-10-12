/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IngestRequest, JobSnapshot, MediaState } from '../../shared/media';
import { Intake } from '../screens/Intake';
import { FilesPanel } from '../shell/FilesPanel';
import { Verify } from '../screens/Verify';
import { StoreProvider, useStore } from '../state/store';
import { fresh } from './fixtures';

/**
 * The screens on the real media engine: what the main process reports is
 * what they show, and what the operator does goes back to it.
 */

const LICENSED = { plan: 'dit', state: 'licensed', email: null, serial: null, paidThrough: null, validUntil: null, message: null };

const card = {
  id: '/Volumes/A015',
  name: 'A015',
  mountPath: '/Volumes/A015',
  kind: 'USB drive',
  filesystem: 'ExFAT',
  totalBytes: 1e12,
  freeBytes: 3e11,
  detected: 'ARRI · ARRIRAW',
  suggestedRole: 'Camera' as const,
  role: 'Camera' as const,
  ingested: false,
  relay: false,
  device: { model: 'CFexpress Type B', bus: 'USB', solidState: true, raid: false },
};
const raid = { ...card, id: '/Volumes/RAID', name: 'RAID', mountPath: '/Volumes/RAID', detected: 'VC DIT media drive', role: 'Destination' as const, suggestedRole: 'Destination' as const };

const leg: JobSnapshot['legs'][number] = {
  id: raid.id,
  name: 'RAID',
  copyPct: 40,
  verifyPct: 0,
  failed: false,
  error: null,
  problemFiles: 0,
  targetDir: '/Volumes/RAID/HALCYON/A015',
  relay: false,
  relayFrom: null,
  waiting: null,
  bytesPerSecond: 0,
  etaSeconds: null,
  currentFile: null,
};

const job = (patch: Partial<JobSnapshot['legs'][number]> = {}): JobSnapshot => ({
  id: 'A015',
  card: 'A015',
  sound: false,
  currentFile: 'A015R1AB/A015C002_261005_R1AB.ari',
  label: 'ARRI · ARRIRAW',
  sourceId: card.id,
  totalBytes: 7e11,
  fileCount: 1284,
  queued: false,
  running: true,
  checksum: 'xxHash64',
  legs: [{ ...leg, ...patch }],
  bytesPerSecond: 850e6,
  etaSeconds: 500,
  startedAt: '2026-10-06T18:00:00Z',
  finishedAt: null,
  clearedAt: null,
});

const entry = (rel: string, kind: 'folder' | 'file', patch: Record<string, unknown> = {}) => ({
  name: rel.split('/').pop()!,
  rel,
  path: `/Volumes/RAID/HALCYON/${rel}`,
  kind,
  size: kind === 'file' ? 4_200_000_000 : 0,
  modified: '2026-10-05T18:00:00.000Z',
  items: kind === 'folder' ? 2 : null,
  linked: false,
  ...patch,
});
const LISTINGS: Record<string, ReturnType<typeof entry>[]> = {
  '': [entry('SHOOT_DAY_014_2026-10-05', 'folder')],
  'SHOOT_DAY_014_2026-10-05': [entry('SHOOT_DAY_014_2026-10-05/CAMERA_ORIGINALS', 'folder'), entry('SHOOT_DAY_014_2026-10-05/REPORTS', 'folder')],
  'SHOOT_DAY_014_2026-10-05/CAMERA_ORIGINALS': [entry('SHOOT_DAY_014_2026-10-05/CAMERA_ORIGINALS/A015', 'folder')],
  'SHOOT_DAY_014_2026-10-05/CAMERA_ORIGINALS/A015': [entry('SHOOT_DAY_014_2026-10-05/CAMERA_ORIGINALS/A015/A015C002_261005_R1AB.ari', 'file', { linked: true })],
};

const CHECK = {
  ok: true,
  card: 'A015',
  files: 1284,
  bytes: 7e11,
  copies: [
    { name: 'RAID', ok: true, problem: null, files: 1284 },
    { name: 'SHTL', ok: true, problem: null, files: 1284 },
  ],
  problems: [] as string[],
  checkedAt: '2026-10-06T19:00:00Z',
};

let listener: ((state: MediaState) => void) | null;
let media: { [K in keyof MediaApi]: ReturnType<typeof vi.fn> };

function Where() {
  const { state } = useStore();
  return <output data-testid="where">{state.screen}</output>;
}

const mount = (ui: React.ReactNode) =>
  render(
    <StoreProvider>
      {ui}
      <Where />
    </StoreProvider>,
  );

const push = (state: MediaState) => act(() => listener?.(state));

beforeEach(() => {
  listener = null;
  media = {
    state: vi.fn(async () => ({ volumes: [card, raid], folders: [], relaysPaused: false, relayLimit: null, jobs: [] })),
    onChange: vi.fn((next: (state: MediaState) => void) => {
      listener = next;
      return () => (listener = null);
    }),
    setRole: vi.fn(async () => ({ ok: true })),
    addFolder: vi.fn(async () => ({ ok: true })),
    removeFolder: vi.fn(async () => undefined),
    ingest: vi.fn(async () => ({ ok: true, jobs: ['A015'] })),
    retry: vi.fn(async () => ({ ok: true, jobs: ['A015'] })),
    stopJob: vi.fn(async () => ({ ok: true })),
    setRelay: vi.fn(async () => ({ ok: true })),
    pauseRelays: vi.fn(async () => undefined),
    setRelayLimit: vi.fn(async () => undefined),
    checkClear: vi.fn(async () => CHECK),
    eject: vi.fn(async () => ({ ok: true })),
    clearCard: vi.fn(async () => ({ ok: true, removed: 1284, check: CHECK })),
    browseRoots: vi.fn(async () => [{ id: raid.id, name: 'RAID', path: '/Volumes/RAID/HALCYON', present: true }]),
    browse: vi.fn(async (_id: string, _production: string, rel: string) => ({ ok: true, more: 0, entries: LISTINGS[rel] ?? [] })),
    browseSearch: vi.fn(async () => ({ ok: true, complete: true, entries: [LISTINGS['SHOOT_DAY_014_2026-10-05/CAMERA_ORIGINALS/A015']![0]!] })),
    reveal: vi.fn(async () => undefined),
    icon: vi.fn(async () => null),
    show: vi.fn(async () => undefined),
  };
  window.vcdit = {
    platform: 'darwin',
    desktop: true,
    license: { now: () => LICENSED, onChange: () => () => {} } as unknown as NonNullable<Window['vcdit']>['license'],
    media: media as unknown as MediaApi,
  };
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  delete window.vcdit;
});

describe('Intake on the media engine', () => {
  it('shows what is plugged in, not the demo day, and sends the ticked card to the ticked destination', async () => {
    mount(<Intake />);
    const sources = screen.getByRole('region', { name: 'Sources' });
    await waitFor(() => expect(within(sources).getByText('A015')).toBeTruthy());
    expect(within(sources).queryByText('B010')).toBeNull();
    expect(sources.textContent).toContain('1.0 TB700 GB used · ExFAT');
    // The RAID, marked Destination, is offered on the right and already picked.
    const out = screen.getByRole('region', { name: 'Destinations' });
    expect((within(out).getByRole('checkbox', { name: 'Write to RAID' }) as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /Start verified ingest/ }));
    // It stays on Intake, where the transfers show as they run.
    await waitFor(() => expect(media.ingest).toHaveBeenCalled());
    expect(screen.getByTestId('where').textContent).not.toBe('verify');
    const request = media.ingest.mock.calls[0]![0] as IngestRequest;
    expect(request).toEqual({
      sources: [card.id],
      destinations: [raid.id],
      checksum: 'xxHash64',
      production: { name: 'HALCYON', code: 'HLC' },
      day: { number: 14, date: '2026-10-05' },
    });
  });

  it('says why the engine refused, and stays put', async () => {
    media.ingest.mockResolvedValueOnce({ ok: false, reason: 'RAID has 300 GB free; this needs about 707 GB.' });
    mount(<Intake />);
    await waitFor(() => screen.getByText('A015'));
    fireEvent.click(screen.getByRole('button', { name: /Start verified ingest/ }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/RAID has 300 GB free/);
    expect(screen.getByTestId('where').textContent).not.toBe('verify');
  });

  it('gives role changes and new folders to the engine', async () => {
    mount(<Intake />);
    await waitFor(() => screen.getByText('A015'));
    fireEvent.change(screen.getByLabelText('Role of RAID'), { target: { value: 'Archive' } });
    expect(media.setRole).toHaveBeenCalledWith(raid.id, 'Archive');
    fireEvent.click(screen.getByRole('button', { name: '+ Add destination folder' }));
    expect(media.addFolder).toHaveBeenCalled();
  });

  it('sets a destination to upload from the backup, and needs one fed from the card', async () => {
    const lucid = { id: 'folder:/lucid', name: 'Filespace', path: '/Volumes/lucid/Filespace', totalBytes: 1e13, freeBytes: 5e12, online: true, relay: true };
    media.state.mockResolvedValueOnce({ volumes: [card, raid], folders: [lucid], jobs: [] });
    mount(<Intake />);
    await waitFor(() => screen.getByText('A015'));
    const out = screen.getByRole('region', { name: 'Destinations' });
    expect(within(out).getByText('LucidLink')).toBeTruthy();
    expect(screen.getByText(/1 destination \+ 1 upload/)).toBeTruthy();
    fireEvent.click(within(within(out).getByRole('group', { name: 'How RAID is fed' })).getByRole('button', { name: 'Upload from backup' }));
    expect(media.setRelay).toHaveBeenCalledWith(raid.id, true);
    // Everything uploading, nothing from the card: it says so instead of starting.
    expect((screen.getByRole('button', { name: /Start verified ingest/ }) as HTMLButtonElement).disabled || screen.queryByText(/copies straight from the card/)).toBeTruthy();
  });

  it('will not eject a card until it is backed up on at least one drive', async () => {
    mount(<Intake />);
    const sources = screen.getByRole('region', { name: 'Sources' });
    await waitFor(() => within(sources).getByText('A015'));
    const tile = () => within(sources).getByText('A015').closest('.offload-tile') as HTMLElement;
    // Not copied: locked.
    expect((within(tile()).getByRole('button', { name: 'Eject A015 (locked until backed up)' }) as HTMLButtonElement).disabled).toBe(true);
    // Copying: still locked.
    push({ volumes: [{ ...card, ingested: true }, raid], folders: [], relaysPaused: false, relayLimit: null, jobs: [job()] });
    expect(within(tile()).getByRole('button', { name: 'Eject A015 (locked until backed up)' })).toBeTruthy();
    // Verified on one drive (not yet safe to clear under the two-copy rule): it may come out.
    push({ volumes: [{ ...card, ingested: true }, raid], folders: [], relaysPaused: false, relayLimit: null, jobs: [{ ...job({ copyPct: 100, verifyPct: 100 }), running: false }] });
    fireEvent.click(within(tile()).getByRole('button', { name: '⏏ Eject A015' }));
    await waitFor(() => expect(media.eject).toHaveBeenCalledWith(card.id));
  });

  it('says what to do when nothing is plugged in', async () => {
    media.state.mockResolvedValueOnce({ volumes: [], folders: [], relaysPaused: false, relayLimit: null, jobs: [] });
    mount(<Intake />);
    expect(await screen.findByText(/No cards yet/)).toBeTruthy();
  });
});

describe('Verify on the media engine', () => {
  it('shows real progress, speed and time left', async () => {
    mount(<Verify />);
    await waitFor(() => expect(media.state).toHaveBeenCalled());
    push({ volumes: [card, raid], folders: [], relaysPaused: false, relayLimit: null, jobs: [job()] });
    expect(screen.getByText('Copying 40%')).toBeTruthy();
    expect(screen.getByText(/850 MB\/s · 8 min left/)).toBeTruthy();
    expect(screen.getByText(/Not safe yet/)).toBeTruthy();
  });

  it('shows why a destination failed and retries it through the engine', async () => {
    mount(<Verify />);
    await waitFor(() => expect(media.state).toHaveBeenCalled());
    push({
      volumes: [card, raid],
      folders: [],
      relaysPaused: false, relayLimit: null,
      jobs: [{ ...job({ copyPct: 100, verifyPct: 100, failed: true, error: 'The destination was disconnected.' }), running: false }],
    });
    expect(screen.getByText(/Problem — don't format/)).toBeTruthy();
    expect(screen.getByText('The destination was disconnected.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry copy A015 → RAID' }));
    expect(media.retry).toHaveBeenCalledWith('A015', raid.id);
  });

  it('calls a card safe to format once two local copies verified, and only then', async () => {
    mount(<Verify />);
    await waitFor(() => expect(media.state).toHaveBeenCalled());
    const done = { copyPct: 100, verifyPct: 100 };
    // One local copy: it can come out, but it is not safe to format.
    push({ volumes: [card, raid], folders: [], relaysPaused: false, relayLimit: null, jobs: [{ ...job(done), running: false, bytesPerSecond: 0 }] });
    expect(screen.getByText(/Can come out · only one local copy/)).toBeTruthy();
    expect(screen.queryByText('Safe to format')).toBeNull();
    // Two: safe.
    const shuttle = { ...leg, ...done, id: '/Volumes/SHTL', name: 'SHTL', targetDir: '/Volumes/SHTL/HALCYON/A015' };
    push({ volumes: [card, raid], folders: [], relaysPaused: false, relayLimit: null, jobs: [{ ...job(done), legs: [{ ...leg, ...done }, shuttle], running: false, bytesPerSecond: 0 }] });
    expect(screen.getByText('Safe to format')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Show' })[0]!);
    expect(media.show).toHaveBeenCalledWith('/Volumes/RAID/HALCYON/A015');
  });

  it('lets the card come out while its upload carries on, and pauses uploads', async () => {
    mount(<Verify />);
    await waitFor(() => expect(media.state).toHaveBeenCalled());
    const done = { copyPct: 100, verifyPct: 100 };
    const shuttle = { ...leg, ...done, id: '/Volumes/SHTL', name: 'SHTL' };
    const cloud = { ...leg, id: 'folder:/lucid', name: 'LucidLink', relay: true, relayFrom: 'RAID', copyPct: 30, verifyPct: 0, bytesPerSecond: 40e6, etaSeconds: 3600 };
    push({ volumes: [card, raid], folders: [], relaysPaused: false, relayLimit: null, jobs: [{ ...job(done), legs: [{ ...leg, ...done }, shuttle, cloud], running: false, bytesPerSecond: 0 }] });
    // Two local copies verified: safe, whatever the upload is doing.
    expect(screen.getByText('Safe to format')).toBeTruthy();
    expect(screen.getByText(/upload from RAID/)).toBeTruthy();
    expect(screen.getByText(/1 upload not finished/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Pause uploads' }));
    expect(media.pauseRelays).toHaveBeenCalledWith(true);
    // Held to 10 MB/s (80 Mbit/s), so the upload leaves room on the set's connection.
    fireEvent.change(screen.getByLabelText('Upload speed limit'), { target: { value: '10000000' } });
    expect(media.setRelayLimit).toHaveBeenCalledWith(10_000_000);
    push({ volumes: [card, raid], folders: [], relaysPaused: false, relayLimit: 10_000_000, jobs: [{ ...job(done), legs: [{ ...leg, ...done }, shuttle, cloud], running: false, bytesPerSecond: 0 }] });
    expect((screen.getByLabelText('Upload speed limit') as HTMLSelectElement).selectedOptions[0]!.textContent).toBe('10 MB/s (80 Mbit/s)');
    fireEvent.change(screen.getByLabelText('Upload speed limit'), { target: { value: '' } });
    expect(media.setRelayLimit).toHaveBeenLastCalledWith(null);
  });

  it('under the every-destination rule, waits for the upload before calling the card safe', async () => {
    const { jobState } = await import('../model/status');
    const local = { name: 'RAID', copyPct: 100, verifyPct: 100, failed: false, rate: 1 };
    const upload = { name: 'Frame.io', copyPct: 40, verifyPct: 0, failed: false, rate: 1, relay: true };
    const card = { id: 'A015', label: '', size: '', files: '', queued: false, checksum: 'xxHash64' as const, legs: [local, { ...local, name: 'SHTL' }, upload] };
    expect(jobState(card, 'two-local')).toBe('safe');
    expect(jobState(card, 'every')).toBe('eject');
    expect(jobState({ ...card, legs: [local, { ...local, name: 'SHTL' }, { ...upload, failed: true }] }, 'two-local')).toBe('safe');
    expect(jobState({ ...card, legs: [local, { ...local, name: 'SHTL' }, { ...upload, failed: true }] }, 'every')).toBe('problem');
    expect(jobState({ ...card, legs: [local, { ...local, name: 'SHTL', failed: true }, upload] }, 'two-local')).toBe('problem');
  });

  it('shows each card to each destination as it copies, with the file, time left and speed, and stops a card', async () => {
    mount(<Intake />);
    await waitFor(() => screen.getByText('A015'));
    push({ volumes: [card, raid], folders: [], relaysPaused: false, relayLimit: null, jobs: [job()] });
    const transfers = screen.getByRole('region', { name: 'Transfers' });
    expect(within(transfers).getByText('A015C002_261005_R1AB.ari')).toBeTruthy();
    expect(within(transfers).getByText(/min left \(850 MB\/s\)/)).toBeTruthy();
    expect(within(transfers).getByText('…/RAID/HALCYON/A015')).toBeTruthy();
    fireEvent.click(within(transfers).getByRole('button', { name: 'Stop A015' }));
    expect(media.stopJob).toHaveBeenCalledWith('A015');
    fireEvent.click(within(transfers).getByRole('button', { name: 'Show A015 on RAID' }));
    expect(media.show).toHaveBeenCalledWith('/Volumes/RAID/HALCYON/A015');

    // Verified: the row says so, and there is nothing to stop.
    push({ volumes: [card, raid], folders: [], relaysPaused: false, relayLimit: null, jobs: [{ ...job({ copyPct: 100, verifyPct: 100 }), running: false, bytesPerSecond: 0, etaSeconds: null, currentFile: null }] });
    expect(within(transfers).getByText('Verified')).toBeTruthy();
    expect(within(transfers).queryByRole('button', { name: 'Stop A015' })).toBeNull();
  });
});

describe('what a source or destination looks like', () => {
  it('draws each as what it is, and names the cloud service a folder syncs with', async () => {
    const { volumeLook, folderLook } = await import('../ui/media-icons');
    expect(volumeLook({ role: 'Camera', media: 'CFexpress B · 1 TB', name: 'A015', filesystem: 'exFAT' }).kind).toBe('card');
    expect(volumeLook({ role: 'Camera', media: 'SD card · 128 GB', name: 'B001', filesystem: 'exFAT' }).kind).toBe('sd');
    expect(volumeLook({ role: 'Sound', media: 'SD · 64 GB', name: '888', filesystem: 'FAT32' }).kind).toBe('sound');
    expect(volumeLook({ role: 'Destination', media: 'Internal drive · 2 TB', name: 'Macintosh HD', filesystem: 'APFS' }).kind).toBe('internal');
    expect(volumeLook({ role: 'Destination', media: 'Thunderbolt drive · 64 TB', name: 'HLC_RAID_01', filesystem: 'APFS' }).kind).toBe('raid');
    expect(volumeLook({ role: 'Shuttle', media: 'USB drive · 4 TB', name: 'SHTL_08', filesystem: 'APFS' }).kind).toBe('shuttle');
    expect(volumeLook({ role: 'Destination', media: 'Network share · 80 TB', name: 'PROD', filesystem: 'smbfs' }).kind).toBe('nas');
    expect(volumeLook({ role: 'Destination', media: 'Drive · 10 TB', name: 'hedge-internal-2', filesystem: 'lucidfs' })).toEqual({ kind: 'cloud', service: 'LucidLink' });
    expect(folderLook({ name: 'Dailies', kind: '/Users/dit/Library/CloudStorage/Dropbox/Dailies' })).toEqual({ kind: 'cloud', service: 'Dropbox' });
    expect(folderLook({ name: 'Marketing', kind: 'G:\\My Drive\\Marketing' })).toEqual({ kind: 'cloud', service: 'Google Drive' });
    expect(folderLook({ name: 'Documents', kind: '/Users/dit/Documents' }).kind).toBe('folder');
  });

  it('tells a RED mag, an AXS card, an SSD, a hard drive and a RAID apart from what the system says', async () => {
    const { volumeLook, brandOf } = await import('../ui/media-icons');
    const device = (model: string | null, patch: Partial<{ bus: string; solidState: boolean; raid: boolean }> = {}) => ({ model, bus: null, solidState: null, raid: false, ...patch });
    const look = (role: string, model: string | null, patch = {}, name = 'X') => volumeLook({ role, media: 'USB drive · 1 TB', name, filesystem: 'exFAT', device: device(model, patch) }).kind;
    expect(look('Camera', 'RED MINI-MAG 960GB')).toBe('redmag');
    expect(look('Camera', 'SONY AXS-A1TS48')).toBe('axs');
    expect(look('Camera', 'Codex Compact Drive 2TB')).toBe('codex');
    expect(look('Camera', 'SanDisk Extreme PRO CFast 2.0')).toBe('cfast');
    expect(look('Camera', null, { bus: 'Secure Digital' })).toBe('sd');
    expect(look('Camera', 'Angelbird AV PRO CFexpress B')).toBe('card');
    expect(look('Shuttle', 'Samsung PSSD T7', { solidState: true })).toBe('shuttle');
    expect(look('Destination', 'Samsung PSSD T7', { solidState: true })).toBe('ssd');
    expect(look('Destination', 'WD Elements 25A3', { solidState: false })).toBe('hdd');
    expect(look('Destination', 'OWC ThunderBay 4')).toBe('raid');
    expect(look('Destination', 'Unknown', { raid: true })).toBe('raid');
    expect(look('Destination', 'RED MINI-MAG 480GB')).toBe('redmag');
    expect(brandOf('ARRI · ARRIRAW')).toBe('arri');
    expect(brandOf('RED · R3D')).toBe('red');
    expect(brandOf('VENICE 2 · X-OCN ST')).toBe('sony');
    expect(brandOf('Blackmagic · BRAW')).toBe('blackmagic');
    expect(brandOf('Sound · 212 WAV')).toBeNull();
  });
});

describe('the Files panel on the drives', () => {
  it('browses the production folder on a destination, folder by folder, with the copy state of a card folder', async () => {
    mount(<FilesPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'On drive' }));
    const tree = await screen.findByRole('tree', { name: 'HALCYON on RAID' });
    expect(media.browseRoots).toHaveBeenCalledWith('HALCYON');
    fireEvent.click(await within(tree).findByText('SHOOT_DAY_014_2026-10-05'));
    fireEvent.click(await within(tree).findByText('CAMERA_ORIGINALS'));
    // The card is copying to RAID: its folder says so.
    push({ volumes: [card, raid], folders: [], relaysPaused: false, relayLimit: null, jobs: [{ ...job(), legs: [{ ...leg, targetDir: '/Volumes/RAID/HALCYON/SHOOT_DAY_014_2026-10-05/CAMERA_ORIGINALS/A015' }] }] });
    const a015 = await within(tree).findByText('A015');
    expect(a015.closest('[role="treeitem"]')!.querySelector('.dot')!.getAttribute('title')).toBe('RAID: copying');
    fireEvent.click(a015);
    const clip = await within(tree).findByText('A015C002_261005_R1AB.ari');
    const clipRow = clip.closest('[role="treeitem"]') as HTMLElement;
    expect(clipRow.textContent).toContain('4.2 GB');
    expect(within(clipRow).getByTitle(/Same data as another name/)).toBeTruthy();
    expect(media.browse).toHaveBeenCalledWith(raid.id, 'HALCYON', 'SHOOT_DAY_014_2026-10-05/CAMERA_ORIGINALS/A015');
    // Show it in Finder, or open it with its app.
    fireEvent.click(within(clipRow).getByRole('button', { name: 'Show A015C002_261005_R1AB.ari in Finder' }));
    expect(media.reveal).toHaveBeenCalledWith(raid.id, 'HALCYON', 'SHOOT_DAY_014_2026-10-05/CAMERA_ORIGINALS/A015/A015C002_261005_R1AB.ari', false);
    fireEvent.doubleClick(clipRow);
    expect(media.reveal).toHaveBeenLastCalledWith(raid.id, 'HALCYON', 'SHOOT_DAY_014_2026-10-05/CAMERA_ORIGINALS/A015/A015C002_261005_R1AB.ari', true);
  });

  it('searches the whole drive folder', async () => {
    localStorage.setItem('vcdit.files.view', 'drive');
    mount(<FilesPanel />);
    await screen.findByRole('tree', { name: 'HALCYON on RAID' });
    fireEvent.change(screen.getByLabelText('Search project files'), { target: { value: 'C002' } });
    expect(await screen.findByText('SHOOT_DAY_014_2026-10-05/CAMERA_ORIGINALS/A015/A015C002_261005_R1AB.ari')).toBeTruthy();
    expect(media.browseSearch).toHaveBeenCalledWith(raid.id, 'HALCYON', 'C002');
  });
});

describe('clearing a card for camera', () => {
  const done = { copyPct: 100, verifyPct: 100 };
  const safeJob = () => ({ ...job(done), legs: [{ ...leg, ...done }, { ...leg, ...done, id: '/Volumes/SHTL', name: 'SHTL' }], running: false, bytesPerSecond: 0, currentFile: null });

  it('colours the card as it goes, and clears it only after a check and two yeses', async () => {
    mount(<Intake />);
    await waitFor(() => screen.getByText('A015'));
    const sources = screen.getByRole('region', { name: 'Sources' });
    const tile = () => within(sources).getByText('A015').closest('.offload-tile') as HTMLElement;
    push({ volumes: [{ ...card, ingested: true }, raid], folders: [], relaysPaused: false, relayLimit: null, jobs: [job()] });
    expect(tile().dataset['stage']).toBe('copying');
    expect(within(tile()).queryByRole('button', { name: 'Clear card…' })).toBeNull();
    // Never ejected mid-copy.
    expect(within(tile()).queryByRole('button', { name: '⏏ Eject A015' })).toBeNull();

    push({ volumes: [{ ...card, ingested: true }, raid], folders: [], relaysPaused: false, relayLimit: null, jobs: [safeJob()] });
    expect(tile().dataset['stage']).toBe('safe');
    expect(within(tile()).getByText('Safe to clear')).toBeTruthy();
    // It can be ejected without clearing, too.
    expect(within(tile()).getByRole('button', { name: '⏏ Eject A015' })).toBeTruthy();
    fireEvent.click(within(tile()).getByRole('button', { name: 'Clear card…' }));

    // 1. The check, fresh.
    const dialog = await screen.findByRole('dialog', { name: 'Clear A015 for camera?' });
    expect(await within(dialog).findByText(/All of this is backed up/)).toBeTruthy();
    expect(within(dialog).getAllByText(/all 1,284 verified copies there now/, { selector: 'span' })).toHaveLength(2);
    expect(media.checkClear).toHaveBeenCalledWith('A015', 'two-local');
    // 2. First yes.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear A015…' }));
    expect(media.clearCard).not.toHaveBeenCalled();
    // 3. Second yes.
    const sure = screen.getByRole('dialog', { name: 'Are you sure?' });
    expect(sure.textContent).toContain('They stay on RAID and SHTL');
    fireEvent.click(within(sure).getByRole('button', { name: 'Yes, clear A015' }));
    expect(media.clearCard).toHaveBeenCalledWith('A015', 'two-local');
    const clear = await screen.findByRole('dialog', { name: 'A015 is clear' });
    // Eject it from there, to hand it back.
    fireEvent.click(within(clear).getByRole('button', { name: '⏏ Eject A015' }));
    await waitFor(() => expect(media.eject).toHaveBeenCalledWith(card.id));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'A015 is clear' })).toBeNull());

    push({ volumes: [{ ...card, ingested: true }, raid], folders: [], relaysPaused: false, relayLimit: null, jobs: [{ ...safeJob(), clearedAt: '2026-10-06T19:01:00Z' }] });
    expect(tile().dataset['stage']).toBe('cleared');
    // Still plugged in after clearing: the tile offers to eject it, and says why it could not.
    media.eject.mockResolvedValueOnce({ ok: false, reason: 'A015 was not ejected. Another app is using it. Close anything showing its files, then eject again.' });
    fireEvent.click(within(tile()).getByRole('button', { name: '⏏ Eject A015' }));
    expect((await within(tile()).findByRole('alert')).textContent).toMatch(/Another app is using it/);
  });

  it('on Verify, locks a card\'s Eject until it is backed up on one drive', async () => {
    mount(<Verify />);
    await waitFor(() => expect(media.state).toHaveBeenCalled());
    push({ volumes: [{ ...card, ingested: true }, raid], folders: [], relaysPaused: false, relayLimit: null, jobs: [job()] });
    expect((screen.getByRole('button', { name: 'Eject A015 (locked until backed up)' }) as HTMLButtonElement).disabled).toBe(true);
    push({ volumes: [{ ...card, ingested: true }, raid], folders: [], relaysPaused: false, relayLimit: null, jobs: [{ ...job({ copyPct: 100, verifyPct: 100 }), running: false }] });
    fireEvent.click(screen.getByRole('button', { name: '⏏ Eject A015' }));
    await waitFor(() => expect(media.eject).toHaveBeenCalledWith(card.id));
  });

  it('says why when the check fails, and offers no way to clear', async () => {
    media.checkClear.mockResolvedValueOnce({ ...CHECK, ok: false, copies: [CHECK.copies[0]!, { name: 'SHTL', ok: false, problem: '3 copies missing or a different size now. Is the drive plugged in?', files: 1281 }], problems: ['SHTL: 3 copies missing or a different size now. Is the drive plugged in?'] });
    mount(<Verify />);
    await waitFor(() => expect(media.state).toHaveBeenCalled());
    push({ volumes: [{ ...card, ingested: true }, raid], folders: [], relaysPaused: false, relayLimit: null, jobs: [safeJob()] });
    fireEvent.click(screen.getByRole('button', { name: 'Clear card…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Clear A015 for camera?' });
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/SHTL: 3 copies missing/);
    expect(within(dialog).queryByRole('button', { name: 'Clear A015…' })).toBeNull();
  });

  it('tells you once when a plugged-in card becomes safe to clear', async () => {
    const { SafeToClearNotices } = await import('../ui/ClearCard');
    mount(<SafeToClearNotices />);
    await waitFor(() => expect(media.state).toHaveBeenCalled());
    push({ volumes: [{ ...card, ingested: true }, raid], folders: [], relaysPaused: false, relayLimit: null, jobs: [job()] });
    expect(screen.queryByText('A015 is safe to clear')).toBeNull();
    push({ volumes: [{ ...card, ingested: true }, raid], folders: [], relaysPaused: false, relayLimit: null, jobs: [safeJob()] });
    expect(await screen.findByText('A015 is safe to clear')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss the notice for A015' }));
    expect(screen.queryByText('A015 is safe to clear')).toBeNull();
  });
});

describe('a shuttle on its way out', () => {
  const shuttle = { ...raid, id: '/Volumes/SHTL_08', name: 'SHTL_08', mountPath: '/Volumes/SHTL_08', role: 'Shuttle' as const, suggestedRole: 'Shuttle' as const };
  const toShuttle = (patch: Partial<JobSnapshot['legs'][number]>) => ({ ...leg, id: shuttle.id, name: 'SHTL_08', targetDir: '/Volumes/SHTL_08/HALCYON/A015', ...patch });

  it('says whether everything on it has verified, and ejects it', async () => {
    media.state.mockResolvedValueOnce({ volumes: [card, raid, shuttle], folders: [], jobs: [], relaysPaused: false, relayLimit: null });
    mount(<Intake />);
    const out = screen.getByRole('region', { name: 'Destinations' });
    await waitFor(() => within(out).getByText('SHTL_08'));
    const tile = () => within(out).getByText('SHTL_08').closest('.offload-tile') as HTMLElement;
    expect(within(tile()).getByText('Nothing copied here today')).toBeTruthy();
    // The RAID stays on the cart: no eject there.
    expect(within(within(out).getByText('RAID').closest('.offload-tile') as HTMLElement).queryByRole('button', { name: /Eject/ })).toBeNull();

    push({ volumes: [card, raid, shuttle], folders: [], relaysPaused: false, relayLimit: null, jobs: [{ ...job(), legs: [leg, toShuttle({ copyPct: 50 })] }] });
    expect(within(tile()).getByText('1 card still copying')).toBeTruthy();
    expect((within(tile()).getByRole('button', { name: 'Eject SHTL_08 (locked until every copy has verified)' }) as HTMLButtonElement).disabled).toBe(true);
    // A failed copy keeps it in too.
    push({ volumes: [card, raid, shuttle], folders: [], relaysPaused: false, relayLimit: null, jobs: [{ ...job(), running: false, legs: [leg, toShuttle({ copyPct: 100, verifyPct: 100, failed: true })] }] });
    expect(within(tile()).getByText('1 card failed here')).toBeTruthy();
    expect(within(tile()).getByRole('button', { name: 'Eject SHTL_08 (locked until every copy has verified)' })).toBeTruthy();
    push({ volumes: [card, raid, shuttle], folders: [], relaysPaused: false, relayLimit: null, jobs: [{ ...job(), running: false, legs: [leg, toShuttle({ copyPct: 100, verifyPct: 100 })] }] });
    expect(within(tile()).getByText('1 card verified · ready to go')).toBeTruthy();
    fireEvent.click(within(tile()).getByRole('button', { name: '⏏ Eject SHTL_08' }));
    await waitFor(() => expect(media.eject).toHaveBeenCalledWith(shuttle.id));
  });
});

describe('sealing a shuttle', () => {
  it('seals a verified shuttle, reading every file back unless told not to, and says what it found', async () => {
    const shuttle = { ...raid, id: '/Volumes/SHTL_08', name: 'SHTL_08', mountPath: '/Volumes/SHTL_08', role: 'Shuttle' as const, suggestedRole: 'Shuttle' as const };
    const outcome = { ok: true, name: 'SHTL_08', root: shuttle.mountPath, files: 1284, bytes: 2.1e12, verified: true, missing: [], changed: [], added: ['HALCYON/x.mxf'], unhashed: 0, problems: [], checkedAt: '2026-10-06T19:40:00Z', manifest: '/Volumes/SHTL_08/HALCYON/SEALS/SEAL.csv' };
    const seal = vi.fn(async () => ({ ok: true, outcome }));
    window.vcdit!.project = { now: () => fresh(), onChange: () => () => undefined, seal, stopSeal: vi.fn(), onSealProgress: vi.fn(() => () => undefined) } as unknown as NonNullable<Window['vcdit']>['project'];
    media.state.mockResolvedValueOnce({
      volumes: [card, raid, shuttle],
      folders: [],
      relaysPaused: false,
      relayLimit: null,
      jobs: [{ ...job({ copyPct: 100, verifyPct: 100 }), running: false, legs: [{ ...leg, copyPct: 100, verifyPct: 100 }, { ...leg, copyPct: 100, verifyPct: 100, id: shuttle.id, name: 'SHTL_08' }] }],
    });
    mount(<Intake />);
    const out = screen.getByRole('region', { name: 'Destinations' });
    await waitFor(() => within(out).getByText('1 card verified · ready to go'));
    fireEvent.click(within(out).getByRole('button', { name: 'Seal…' }));
    const dialog = screen.getByRole('dialog', { name: 'Seal SHTL_08' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Seal SHTL_08' }));
    await within(screen.getByRole('dialog')).findByText('SHTL_08 is sealed');
    expect(seal).toHaveBeenCalledWith(shuttle.id, true);
    expect(screen.getByRole('dialog').textContent).toMatch(/1,284 files .* read back and matched their checksums/);
    expect(screen.getByRole('dialog').textContent).toMatch(/1 file in its card folders is not from this production/);
  });

  it('says why a drive was not sealed, file by file', async () => {
    const shuttle = { ...raid, id: '/Volumes/SHTL_08', name: 'SHTL_08', mountPath: '/Volumes/SHTL_08', role: 'Shuttle' as const, suggestedRole: 'Shuttle' as const };
    const outcome = { ok: false, name: 'SHTL_08', root: shuttle.mountPath, files: 2, bytes: 10, verified: false, missing: ['HALCYON/A015/C001.mxf'], changed: [], added: [], unhashed: 0, problems: ['1 file copied here is not on the drive now, e.g. HALCYON/A015/C001.mxf.'], checkedAt: '', manifest: null };
    window.vcdit!.project = { now: () => fresh(), onChange: () => () => undefined, seal: vi.fn(async () => ({ ok: false, reason: outcome.problems[0], outcome })), stopSeal: vi.fn(), onSealProgress: vi.fn(() => () => undefined) } as unknown as NonNullable<Window['vcdit']>['project'];
    media.state.mockResolvedValueOnce({
      volumes: [card, raid, shuttle],
      folders: [],
      relaysPaused: false,
      relayLimit: null,
      jobs: [{ ...job({ copyPct: 100, verifyPct: 100 }), running: false, legs: [{ ...leg, copyPct: 100, verifyPct: 100, id: shuttle.id, name: 'SHTL_08' }] }],
    });
    mount(<Intake />);
    const out = screen.getByRole('region', { name: 'Destinations' });
    await waitFor(() => within(out).getByRole('button', { name: 'Seal…' }));
    fireEvent.click(within(out).getByRole('button', { name: 'Seal…' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Read every file back/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Seal SHTL_08' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/not on the drive now/);
    expect(screen.getByText('missing · HALCYON/A015/C001.mxf')).toBeTruthy();
  });
});

describe('eject all', () => {
  it('ticks what can go, leaves the main backup and fresh cards unticked, never offers one being copied, and ejects each in turn', async () => {
    const shuttle = { ...raid, id: '/Volumes/SHTL_08', name: 'SHTL_08', mountPath: '/Volumes/SHTL_08', role: 'Shuttle' as const, suggestedRole: 'Shuttle' as const };
    const fresh = { ...card, id: '/Volumes/B010', name: 'B010', mountPath: '/Volumes/B010' };
    const copying = { ...card, id: '/Volumes/C001', name: 'C001', mountPath: '/Volumes/C001', ingested: true };
    const done = { copyPct: 100, verifyPct: 100 };
    const twoCopies = [{ ...leg, ...done }, { ...leg, ...done, id: shuttle.id, name: 'SHTL_08' }];
    media.state.mockResolvedValueOnce({
      volumes: [{ ...card, ingested: true }, fresh, copying, raid, shuttle],
      folders: [],
      relaysPaused: false,
      relayLimit: null,
      jobs: [
        { ...job(done), legs: twoCopies, running: false, clearedAt: '2026-10-06T19:00:00Z' },
        { ...job(), id: 'C001', card: 'C001', sourceId: copying.id, legs: [{ ...leg, copyPct: 20 }] },
      ],
    });
    media.eject.mockImplementation(async (id: string) => (id === shuttle.id ? { ok: false, reason: 'SHTL_08 was not ejected. Another app may be using it.' } : { ok: true }));
    mount(<Intake />);
    await waitFor(() => screen.getByText('B010'));
    fireEvent.click(screen.getByRole('button', { name: '⏏ Eject all…' }));
    const dialog = screen.getByRole('dialog', { name: 'Eject cards and drives' });
    const box = (name: string) => within(dialog).getByRole('checkbox', { name: `Eject ${name}` }) as HTMLInputElement;
    expect([box('A015').checked, box('SHTL_08').checked]).toEqual([true, true]);
    // B010 is not backed up: it stays in.
    expect([box('B010').checked, box('B010').disabled]).toEqual([false, true]);
    // C001 is copying, to the RAID: neither is offered.
    expect([box('C001').disabled, box('RAID').disabled]).toEqual([true, true]);
    expect(within(dialog).getByText('Being copied to')).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: '⏏ Eject 2' }));
    await within(dialog).findByRole('button', { name: 'Done' });
    expect(media.eject.mock.calls.map((call) => call[0])).toEqual([card.id, shuttle.id]);
    expect(within(dialog).getByText('Ejected')).toBeTruthy();
    expect(within(dialog).getByText(/SHTL_08 was not ejected/)).toBeTruthy();
    expect(within(dialog).getByText(/1 could not be ejected/)).toBeTruthy();
  });

  it('lists the main backup unticked when nothing is copying to it', async () => {
    mount(<Intake />);
    await waitFor(() => screen.getByText('A015'));
    fireEvent.click(screen.getByRole('button', { name: '⏏ Eject all…' }));
    const dialog = screen.getByRole('dialog', { name: 'Eject cards and drives' });
    expect(within(dialog).getByText('Main backup')).toBeTruthy();
    expect((within(dialog).getByRole('checkbox', { name: 'Eject RAID' }) as HTMLInputElement).checked).toBe(false);
    expect(within(dialog).getByText('Not backed up · stays in')).toBeTruthy();
    expect((within(dialog).getByRole('checkbox', { name: 'Eject A015' }) as HTMLInputElement).disabled).toBe(true);
    expect(within(dialog).getByRole('button', { name: '⏏ Eject 0' })).toHaveProperty('disabled', true);
  });

  it('is on Verify too, with the same safeguard: a card not backed up stays in', async () => {
    mount(<Verify />);
    fireEvent.click(await screen.findByRole('button', { name: '⏏ Eject all…' }));
    const dialog = screen.getByRole('dialog', { name: 'Eject cards and drives' });
    const a015 = within(dialog).getByRole('checkbox', { name: 'Eject A015' }) as HTMLInputElement;
    expect([a015.checked, a015.disabled]).toEqual([false, true]);
    expect(within(dialog).getByText('Not backed up · stays in')).toBeTruthy();
  });

  it('on Verify, lists the shuttle going out with the same safeguard', async () => {
    const shuttle = { ...raid, id: '/Volumes/SHTL_08', name: 'SHTL_08', mountPath: '/Volumes/SHTL_08', role: 'Shuttle' as const, suggestedRole: 'Shuttle' as const };
    const toShuttle = (patch: Partial<JobSnapshot['legs'][number]>) => ({ ...leg, id: shuttle.id, name: 'SHTL_08', targetDir: '/Volumes/SHTL_08/HALCYON/A015', ...patch });
    media.state.mockResolvedValueOnce({ volumes: [card, raid, shuttle], folders: [], jobs: [], relaysPaused: false, relayLimit: null });
    mount(<Verify />);
    const out = await screen.findByRole('region', { name: 'Drives going out' });
    push({ volumes: [card, raid, shuttle], folders: [], relaysPaused: false, relayLimit: null, jobs: [{ ...job(), running: false, legs: [leg, toShuttle({ copyPct: 100, verifyPct: 100, failed: true })] }] });
    expect(within(out).getByText('1 card failed here')).toBeTruthy();
    expect((within(out).getByRole('button', { name: 'Eject SHTL_08 (locked until every copy has verified)' }) as HTMLButtonElement).disabled).toBe(true);
    push({ volumes: [card, raid, shuttle], folders: [], relaysPaused: false, relayLimit: null, jobs: [{ ...job(), running: false, legs: [leg, toShuttle({ copyPct: 100, verifyPct: 100 })] }] });
    fireEvent.click(within(out).getByRole('button', { name: '⏏ Eject SHTL_08' }));
    await waitFor(() => expect(media.eject).toHaveBeenCalledWith(shuttle.id));
    // The RAID is not going anywhere: not listed.
    expect(within(out).queryByText('RAID')).toBeNull();
  });

  it('on Verify, Eject all keeps a shuttle in until every copy to it has verified', async () => {
    const shuttle = { ...raid, id: '/Volumes/SHTL_08', name: 'SHTL_08', mountPath: '/Volumes/SHTL_08', role: 'Shuttle' as const, suggestedRole: 'Shuttle' as const };
    const toShuttle = (patch: Partial<JobSnapshot['legs'][number]>) => ({ ...leg, id: shuttle.id, name: 'SHTL_08', targetDir: '/Volumes/SHTL_08/HALCYON/A015', ...patch });
    media.state.mockResolvedValueOnce({ volumes: [card, raid, shuttle], folders: [], jobs: [], relaysPaused: false, relayLimit: null });
    mount(<Verify />);
    await screen.findByRole('region', { name: 'Drives going out' });
    push({ volumes: [card, raid, shuttle], folders: [], relaysPaused: false, relayLimit: null, jobs: [{ ...job(), running: false, legs: [leg, toShuttle({ copyPct: 100, verifyPct: 100, failed: true })] }] });
    fireEvent.click(screen.getByRole('button', { name: '⏏ Eject all…' }));
    const dialog = screen.getByRole('dialog', { name: 'Eject cards and drives' });
    const box = within(dialog).getByRole('checkbox', { name: 'Eject SHTL_08' }) as HTMLInputElement;
    expect([box.checked, box.disabled]).toEqual([false, true]);
    expect(within(dialog).getByText('A copy failed · stays in')).toBeTruthy();
  });
});
