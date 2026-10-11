/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IngestRequest, JobSnapshot, MediaState } from '../../shared/media';
import { Intake } from '../screens/Intake';
import { Verify } from '../screens/Verify';
import { StoreProvider, useStore } from '../state/store';

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
});

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
