/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_DAILIES, DEFAULT_DELIVERY, type DeliveryState, type ProjectResult, type ProjectState } from '../../shared/project';
import { App } from '../App';
import type { ScreenId } from '../model/types';
import { MatchReview } from '../screens/MatchReview';
import { ProjectSetup } from '../screens/ProjectSetup';
import { SceneOrganizer } from '../screens/SceneOrganizer';
import { SyncWorkspace } from '../screens/SyncWorkspace';
import { VfxHandoff } from '../screens/VfxHandoff';
import { Looks } from '../screens/Looks';
import { Dailies } from '../screens/Dailies';
import { Delivery } from '../screens/Delivery';
import { Reports } from '../screens/Reports';
import { FilesPanel } from '../shell/FilesPanel';
import { StoreProvider, useStore } from '../state/store';

/**
 * The screens on the production database: a fresh production opens with
 * nothing of the demo day in it, edits are written through, and days and
 * productions are switched by the database.
 */

const LICENSED = { plan: 'dit', state: 'licensed', email: null, serial: null, paidThrough: null, validUntil: null, message: null };

const fresh = (patch: Partial<ProjectState> = {}): ProjectState => ({
  file: '/data/productions/nightjar.vcdit',
  production: { name: 'NIGHTJAR', code: 'NJR', frameRate: '25 fps', checksum: 'MD5', totalDays: 30, devices: [], namingTokens: ['{PROD}', '_', 'D{DAY}'], vfxMethod: 'Hard link' },
  day: { number: 1, date: '2026-10-06', locations: '', operator: { name: '', initials: '' }, notes: '' },
  days: [{ number: 1, date: '2026-10-06', locations: '', operator: { name: '', initials: '' }, notes: '' }],
  scenes: [],
  log: null,
  matches: [],
  vfx: [],
  vfxActivity: null,
  sync: [],
  syncActivity: null,
  luts: [],
  lutRules: [],
  previewClips: [],
  dailies: DEFAULT_DAILIES,
  renders: [],
  dailiesActivity: null,
  ffmpeg: null,
  organize: { placed: 0, references: 0, failed: 0, pending: 0, folders: [], problems: [], activity: null },
  media: { cameraFiles: 0, soundFiles: 0, cards: 0, home: null },
  delivery: { settings: DEFAULT_DELIVERY, places: [], parts: [], scanning: false, scannedAt: null, records: [], activity: null, error: null },
  recent: [{ file: '/data/productions/nightjar.vcdit', name: 'NIGHTJAR' }, { file: '/data/productions/halcyon.vcdit', name: 'HALCYON' }],
  ...patch,
});

const take = (n: number, patch: Partial<ProjectState['scenes'][number]['setups'][number]['takes'][number]> = {}) => ({
  id: `4|A|${n}`,
  take: `T0${n}`,
  clipA: `A001C00${n}`,
  clipB: null,
  sound: `4A-T0${n}`,
  tc: '10:00:00:00',
  duration: '0:40',
  circle: n === 2,
  vfx: false,
  match: 'Matched' as const,
  sync: 'pending' as const,
  ...patch,
});

/** The production after importing a log: one scene, two takes, one entry to review. */
const logged = fresh({
  scenes: [{ id: '4', description: 'INT. KITCHEN – NIGHT', status: 'Shot', notes: '', look: '', setups: [{ id: 'A', lens: '35mm', takes: [take(1), take(2, { match: 'Review', clipA: '—' })] }] }],
  log: { file: 'day1.csv', format: 'CSV', importedAt: '18:40', entries: 2, vfxFlags: 0, matched: 1, review: 1, unmatched: 0, warnings: ['Line 9: no take number — skipped.'] },
  matches: [
    {
      id: '7:0',
      log: 'Sc 4 / A / T02',
      reason: 'No clip name in the log: matched by roll and time only. Confirm the right one.',
      fields: [['Scene', '4']],
      candidates: [
        { clip: 'A001C002', tc: '10:01:02', confidence: 74, why: 'File time 3s from the logged end TC' },
        { clip: 'A001C003', tc: '10:04:40', confidence: 31, why: 'File time 4 min from the logged end TC' },
      ],
      picked: 0,
      resolution: null,
    },
  ],
});

let current: ProjectState;
let api: { [K in keyof ProjectApi]: ReturnType<typeof vi.fn> };
let broadcast: ((state: ProjectState) => void) | null;
const ok = (state: ProjectState): ProjectResult => ({ ok: true, state });

function Where() {
  const { state } = useStore();
  return <output data-testid="checksum">{state.checksum}</output>;
}

beforeEach(() => {
  current = fresh();
  broadcast = null;
  api = {
    now: vi.fn(() => current),
    onChange: vi.fn((listener: (state: ProjectState) => void) => {
      broadcast = listener;
      return () => (broadcast = null);
    }),
    update: vi.fn(async () => ok(current)),
    updateDay: vi.fn(async () => ok(current)),
    addScene: vi.fn(async () => ok(current)),
    updateScene: vi.fn(async () => ok(current)),
    removeScene: vi.fn(async () => ok(current)),
    addDay: vi.fn(async () => ok(fresh({ day: { number: 2, date: '2026-10-07', locations: '', operator: { name: '', initials: '' }, notes: '' } }))),
    openDay: vi.fn(async () => ok(current)),
    create: vi.fn(async () => ok(current)),
    open: vi.fn(async () => ({ ok: false, reason: 'A transfer is running. Wait for it to finish first.' })),
    saveCopy: vi.fn(async () => ok(current)),
    reveal: vi.fn(async () => undefined),
    importLog: vi.fn(async () => ok(logged)),
    resolveMatch: vi.fn(async () => ok(logged)),
    saveLogTemplate: vi.fn(async () => ok(current)),
    tagVfx: vi.fn(async () => ok(current)),
    mirrorVfx: vi.fn(async () => ok(current)),
    sendVfx: vi.fn(async () => ok(current)),
    syncWaveform: vi.fn(async () => ok(current)),
    syncNudge: vi.fn(async () => ok(current)),
    syncAccept: vi.fn(async () => ok(current)),
    importLuts: vi.fn(async () => ok(current)),
    removeLut: vi.fn(async () => ok(current)),
    setLutRule: vi.fn(async () => ok(current)),
    removeLutRule: vi.fn(async () => ok(current)),
    previewLook: vi.fn(async () => ({ ok: true, original: 'data:image/jpeg;base64,AA', graded: 'data:image/jpeg;base64,BB' })),
    saveDailies: vi.fn(async () => ok(current)),
    startDailies: vi.fn(async () => ok(current)),
    stopDailies: vi.fn(async () => ok(current)),
    showDaily: vi.fn(async () => undefined),
    saveDelivery: vi.fn(async () => ok(current)),
    refreshDelivery: vi.fn(async () => ok(current)),
    startDelivery: vi.fn(async () => ok(current)),
    stopDelivery: vi.fn(async () => ok(current)),
    retryDelivery: vi.fn(async () => ok(current)),
    addDeliveryFolder: vi.fn(async () => ok(current)),
    removeDeliveryFolder: vi.fn(async () => ok(current)),
    saveManifest: vi.fn(async () => ok(current)),
    showManifest: vi.fn(async () => undefined),
    showSceneFolder: vi.fn(async () => undefined),
    reports: vi.fn(async () => []),
    showReport: vi.fn(async () => undefined),
    dayReport: vi.fn(async () => ({ ok: true, written: ['/Volumes/RAID/NIGHTJAR/SHOOT_DAY_001_2026-10-06/REPORTS/day_report/NJR_D001_REPORT.pdf'] })),
  };
  window.vcdit = {
    platform: 'darwin',
    desktop: true,
    license: { now: () => LICENSED, onChange: () => () => {} } as unknown as NonNullable<Window['vcdit']>['license'],
    project: api as unknown as ProjectApi,
  };
});

afterEach(() => {
  cleanup();
  delete window.vcdit;
});

describe('a production from the database', () => {
  it('opens on the first frame with its own name, day and settings, and no demo scenes', () => {
    render(
      <StoreProvider>
        <ProjectSetup />
        <Where />
      </StoreProvider>,
    );
    expect((screen.getByRole('textbox', { name: 'Production' }) as HTMLInputElement).value).toBe('NIGHTJAR');
    expect(screen.getByText(/No scenes on today's list yet/)).toBeTruthy();
    expect(screen.queryByLabelText('Scene 14 status')).toBeNull();
    // The production's checksum default is the one Intake starts with.
    expect(screen.getByTestId('checksum').textContent).toBe('MD5');
  });

  it('writes edits through as they are made', () => {
    render(
      <StoreProvider>
        <ProjectSetup />
      </StoreProvider>,
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Production' }), { target: { value: 'NIGHTJAR II' } });
    expect(api.update).toHaveBeenCalledWith({ name: 'NIGHTJAR II' });

    fireEvent.change(screen.getByLabelText('New scene number'), { target: { value: '4a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add scene' }));
    expect(api.addScene).toHaveBeenCalledWith({ id: '4a', description: 'Added on the day' });
    fireEvent.change(screen.getByLabelText('Scene 4A status'), { target: { value: 'Shot' } });
    expect(api.updateScene).toHaveBeenCalledWith('4A', { status: 'Shot' });
    fireEvent.click(screen.getByRole('button', { name: 'Remove scene 4A' }));
    expect(api.removeScene).toHaveBeenCalledWith('4A');

    fireEvent.change(screen.getByLabelText('New device name'), { target: { value: 'ALEXA 35' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(api.update).toHaveBeenLastCalledWith({ devices: [{ slot: 'A', name: 'ALEXA 35', format: '' }] });

    fireEvent.change(screen.getByRole('textbox', { name: 'DIT' }), { target: { value: 'Morgan Reyes' } });
    expect(api.updateDay).toHaveBeenLastCalledWith({ operator: { name: 'Morgan Reyes', initials: 'MR' } });
  });

  it('starts a new day through the database, and says why when it cannot switch', async () => {
    render(
      <StoreProvider>
        <ProjectSetup />
      </StoreProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'New day' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: /Day 002 scene list/ })).toBeTruthy());

    fireEvent.change(screen.getByLabelText('Open production'), { target: { value: '/data/productions/halcyon.vcdit' } });
    expect(api.open).toHaveBeenCalledWith('/data/productions/halcyon.vcdit');
    expect((await screen.findByRole('alert')).textContent).toMatch(/A transfer is running/);
  });

  it('follows a production opened elsewhere', async () => {
    render(
      <StoreProvider>
        <ProjectSetup />
        <Where />
      </StoreProvider>,
    );
    act(() =>
      broadcast?.(
        fresh({ file: '/data/productions/halcyon.vcdit', production: { ...fresh().production, name: 'HALCYON', checksum: 'SHA-1' } }),
      ),
    );
    expect((screen.getByRole('textbox', { name: 'Production' }) as HTMLInputElement).value).toBe('HALCYON');
    expect(screen.getByTestId('checksum').textContent).toBe('SHA-1');
  });

  it('every screen opens on an empty production without breaking', () => {
    render(
      <StoreProvider>
        <App />
      </StoreProvider>,
    );
    const screens: ScreenId[] = ['today', 'setup', 'intake', 'verify', 'scenes', 'match', 'vfx', 'sync', 'looks', 'dailies', 'delivery', 'reports'];
    for (const id of screens) {
      act(() => (window as unknown as { __vcditGo: (screen: string) => void }).__vcditGo(id));
      // A render error would throw here; each screen shows its content.
      expect(document.body.textContent!.length, id).toBeGreaterThan(100);
    }
  });

  it("imports the day's log from Project setup and shows how it matched", async () => {
    render(
      <StoreProvider>
        <ProjectSetup />
      </StoreProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save a template CSV…' }));
    expect(api.saveLogTemplate).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Import log…' }));
    expect(await screen.findByText('day1.csv')).toBeTruthy();
    expect(screen.getByText('1 needs a decision in Match review')).toBeTruthy();
    expect(screen.getByText('1 row not fully read (CSV)')).toBeTruthy();
  });

  it('lays the takes out in the Scene Organizer and sends a match decision to the database', async () => {
    current = logged;
    render(
      <StoreProvider>
        <SceneOrganizer />
        <MatchReview />
      </StoreProvider>,
    );
    expect(screen.getAllByText('A001C001').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm match' }));
    expect(api.resolveMatch).toHaveBeenCalledWith('7:0', 'A001C002');
  });

  it('shows each VFX shot where it really is, and mirrors, sends and switches method through the database', async () => {
    const location = (destination: string, state: 'mirrored' | 'pending' | 'failed', error: string | null = null) => ({
      destination,
      editorial: `/Volumes/${destination}/NIGHTJAR/SHOOT_DAY_001_2026-10-06/CAMERA_ORIGINALS/A001/A001R1`,
      mirror: state === 'pending' ? null : `/Volumes/${destination}/NIGHTJAR/SHOOT_DAY_001_2026-10-06/VFX/SCENE_004/SETUP_A/T01_A001C001`,
      method: state === 'pending' ? null : ('Hard link' as const),
      state,
      error,
    });
    current = fresh({
      vfx: [
        {
          key: '4|A|01|A001|A001C001',
          scene: '4',
          setup: 'A',
          take: '01',
          clip: 'A001C001',
          note: 'Window comp',
          flaggedBy: 'Script sup.',
          matched: true,
          locations: [location('RAID', 'mirrored'), location('SHUTTLE', 'failed', 'SHUTTLE is not available, or its copy of the clip has gone.')],
          sentAt: null,
        },
        { key: '4|A|02|-|A001C009', scene: '4', setup: 'A', take: '02', clip: 'A001C009', note: '', flaggedBy: 'Script sup.', matched: false, locations: [], sentAt: null },
      ],
    });
    render(
      <StoreProvider>
        <VfxHandoff />
      </StoreProvider>,
    );
    expect(screen.getByText('Mirror failed')).toBeTruthy();
    expect(screen.getByText('Blocked · match')).toBeTruthy();
    expect(screen.getByText('SHUTTLE is not available, or its copy of the clip has gone.')).toBeTruthy();
    expect(screen.getByText(/RAID · VFX mirror · Hard link/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Mirror 1 now' }));
    expect(api.mirrorVfx).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Send 1 to VC VFX Prep/ }));
    expect(api.sendVfx).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Physical copy' }));
    expect(api.update).toHaveBeenCalledWith({ vfxMethod: 'Physical copy' });
  });

  it("shows the day's real sync, and nudges, accepts and runs the waveform pass through the database", () => {
    const entry = (patch: Partial<ProjectState['sync'][number]>): ProjectState['sync'][number] => ({
      id: 'A001|A001C001',
      take: '4A-01',
      clip: 'A001C001',
      sound: '4A-T01',
      method: 'Timecode',
      offsetFrames: 0,
      confidence: 99,
      accepted: true,
      fps: 24000 / 1001,
      why: 'Timecode: the sound file covers the whole clip; the waveform agrees',
      barsPicture: [10, 80, 40],
      barsSound: [12, 78, 41],
      ...patch,
    });
    current = fresh({
      sync: [
        entry({}),
        entry({ id: 'A001|A001C002', take: '4A-02', clip: 'A001C002', sound: '—', method: 'None', confidence: 0, accepted: false, why: "No sound file's timecode overlaps this clip. Try the waveform pass.", barsPicture: [], barsSound: [] }),
        entry({ id: 'A001|A001C003', take: '4A-03', clip: 'A001C003', method: 'Timecode', confidence: 99, accepted: false }),
      ],
    });
    render(
      <StoreProvider>
        <SyncWorkspace />
      </StoreProvider>,
    );
    expect(screen.getByText(/the waveform agrees/)).toBeTruthy();
    expect(screen.getByText('1 frame @ 23.976 fps')).toBeTruthy();
    expect(screen.getByText('No sound')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Nudge sound one frame later' }));
    expect(api.syncNudge).toHaveBeenCalledWith('A001|A001C001', 1);
    fireEvent.click(screen.getByRole('button', { name: 'Waveform pass on exceptions' }));
    expect(api.syncWaveform).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Accept 1 at 90%+' }));
    expect(api.syncAccept).toHaveBeenCalledWith(['A001|A001C003']);
  });

  it('shows the LUT library, previews the real frame through the look, and edits rules through the database', async () => {
    current = fresh({
      luts: [
        { id: 1, name: 'NJR_Show_v3.cube', title: 'Show LUT', kind: '3D', size: 33, format: 'cube', importedAt: 'x', isDefault: true },
        { id: 2, name: 'NJR_Night_v1.cube', title: '', kind: '3D', size: 33, format: 'cube', importedAt: 'x', isDefault: false },
      ],
      lutRules: [{ id: 5, scope: 'Project', target: 'Default', lut: 'NJR_Show_v3.cube', lutId: 1, clips: 4 }],
      previewClips: [{ id: 'A001|A001C001', label: 'A001C001 · Sc 4 / A / T01' }],
      ffmpeg: { version: '6.0' },
    });
    render(
      <StoreProvider>
        <Looks />
      </StoreProvider>,
    );
    expect(screen.getByRole('option', { name: /NJR_Show_v3\.cube\s*Project default/ })).toBeTruthy();
    await waitFor(() => expect(api.previewLook).toHaveBeenCalledWith('A001|A001C001', 1));
    expect(((await screen.findByAltText('The clip through the look')) as HTMLImageElement).src).toBe('data:image/jpeg;base64,BB');

    fireEvent.click(screen.getByRole('option', { name: /NJR_Night_v1/ }));
    await waitFor(() => expect(api.previewLook).toHaveBeenLastCalledWith('A001|A001C001', 2));
    fireEvent.change(screen.getByLabelText('Rule applies to'), { target: { value: 'Scene' } });
    fireEvent.change(screen.getByLabelText('Rule target'), { target: { value: '21' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use NJR_Night_v1' }));
    expect(api.setLutRule).toHaveBeenCalledWith('Scene', '21', 2);
    fireEvent.click(screen.getByRole('button', { name: 'Make project default' }));
    expect(api.setLutRule).toHaveBeenLastCalledWith('Project', 'Default', 2);
    fireEvent.click(screen.getByRole('button', { name: 'Remove the Project rule for Default' }));
    expect(api.removeLutRule).toHaveBeenCalledWith(5);
  });

  it('renders dailies to a chosen destination and lists what was rendered', async () => {
    current = fresh({
      ...logged,
      ffmpeg: { version: '6.0' },
      renders: [
        { takeId: '4|A|2', label: '4A-02', clip: 'A001C002', output: '/RAID/x.mov', state: 'done', error: null, lut: 'NJR_Show_v3.cube', codec: 'ProRes 422 Proxy', bytes: 52_000_000, warnings: [] },
        { takeId: '4|A|1', label: '4A-01', clip: 'A001C001', output: '', state: 'failed', error: 'No copy of this clip can be read right now.', lut: null, codec: 'ProRes 422 Proxy', bytes: null, warnings: [] },
      ],
    });
    render(
      <StoreProvider>
        <Dailies />
      </StoreProvider>,
    );
    expect(screen.getByText('No copy of this clip can be read right now.')).toBeTruthy();
    expect(screen.getByText(/NJR_Show_v3\.cube · 52\.0 MB/)).toBeTruthy();
    // No destination chosen yet: the button says so.
    expect((screen.getByRole('button', { name: /Build dailies again/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Pick where the dailies go.')).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: 'Codec' }), { target: { value: 'DNxHR LB' } });
    expect(api.saveDailies).toHaveBeenLastCalledWith(expect.objectContaining({ codec: 'DNxHR LB' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(api.showDaily).toHaveBeenCalledWith('/RAID/x.mov');
  });

  it('preflights the real drives, delivers through the database, and retries what did not verify', async () => {
    const GB = 1e9;
    const delivery: DeliveryState = {
      settings: { ...DEFAULT_DELIVERY, packages: ['edit', 'dailies', 'reports'], destinations: ['/Volumes/SHTL_03'] },
      places: [
        { id: '/Volumes/RAID', name: 'RAID', kind: 'Destination', root: '/Volumes/RAID', freeBytes: 8000 * GB, totalBytes: 16000 * GB },
        { id: '/Volumes/SHTL_03', name: 'SHTL_03', kind: 'Shuttle', root: '/Volumes/SHTL_03', freeBytes: 500 * GB, totalBytes: 2000 * GB },
        { id: '/Volumes/ARCHIVE', name: 'ARCHIVE', kind: 'Archive', root: '/Volumes/ARCHIVE', freeBytes: 300 * GB, totalBytes: 4000 * GB },
      ],
      parts: [
        { id: 'camera', sourceId: '/Volumes/RAID', source: 'RAID', files: 400, bytes: 600 * GB, present: { '/Volumes/SHTL_03': 600 * GB, '/Volumes/ARCHIVE': 0 } },
        { id: 'sound', sourceId: '/Volumes/RAID', source: 'RAID', files: 40, bytes: 2 * GB, present: {} },
        { id: 'dailies', sourceId: '/Volumes/RAID', source: 'RAID', files: 20, bytes: 40 * GB, present: {} },
        { id: 'reports', sourceId: '/Volumes/RAID', source: 'RAID', files: 6, bytes: 0.001 * GB, present: {} },
      ],
      scanning: false,
      scannedAt: '2026-10-06T21:00:00Z',
      records: [
        {
          package: 'dailies',
          packageName: 'Synced dailies',
          destinationId: '/Volumes/SHTL_03',
          destination: 'SHTL_03',
          source: 'RAID',
          files: 20,
          bytes: 40 * GB,
          verified: 19,
          alreadyThere: 0,
          failed: 1,
          retries: 0,
          startedAt: '2026-10-06T21:00:00Z',
          finishedAt: '2026-10-06T21:10:00Z',
          problems: [{ path: 'SYNCED_DAILIES/4A-02.mov', error: 'Checksum mismatch' }],
          mhl: null,
        },
      ],
      activity: null,
      error: null,
    };
    current = fresh({ delivery });
    render(
      <StoreProvider>
        <Delivery />
      </StoreProvider>,
    );
    await waitFor(() => expect(api.refreshDelivery).toHaveBeenCalled());
    // The shuttle already holds the originals: it needs only the sound, dailies and reports.
    expect(screen.getByText(/✓ 458 GB left/)).toBeTruthy();
    expect((screen.getByRole('button', { name: /Deliver & verify/ }) as HTMLButtonElement).disabled).toBe(false);

    // The archive has the room for none of it.
    fireEvent.click(screen.getByRole('checkbox', { name: 'ARCHIVE' }));
    expect(api.saveDelivery).toHaveBeenLastCalledWith({ destinations: ['/Volumes/SHTL_03', '/Volumes/ARCHIVE'] });
    expect(screen.getAllByText(/Not enough space on ARCHIVE/).length).toBeGreaterThan(0);
    expect((screen.getByRole('button', { name: /Deliver & verify/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'ARCHIVE' }));

    fireEvent.click(screen.getByRole('button', { name: /Deliver & verify/ }));
    expect(api.startDelivery).toHaveBeenCalled();

    expect(screen.getByText(/1 not verified/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry file' }));
    expect(api.retryDelivery).toHaveBeenCalledWith('dailies', '/Volumes/SHTL_03');

    fireEvent.change(screen.getByLabelText('Delivery preset'), { target: { value: 'Archive' } });
    expect(api.saveDelivery).toHaveBeenLastCalledWith({ packages: ['ocf', 'reports'], destinations: ['/Volumes/SHTL_03'] });
  });

  it('edits the naming template and shows the scene folders on the drives', () => {
    current = fresh({
      ...logged,
      organize: {
        placed: 12,
        references: 2,
        failed: 1,
        pending: 0,
        folders: [{ destination: 'RAID', path: '/Volumes/RAID/NIGHTJAR/SHOOT_DAY_001_2026-10-06/CAMERA_ORIGINALS/_BY_SCENE' }],
        problems: [{ clip: 'A001C002', destination: 'SHTL', error: 'A different file is already in the scene folder: CLIPS/A001C002.mov. It was not replaced.' }],
        activity: null,
      },
    });
    render(
      <StoreProvider>
        <ProjectSetup />
        <SceneOrganizer />
      </StoreProvider>,
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Naming template' }), { target: { value: '{PROD}_SC{SCENE}{SETUP}_T{TAKE}' } });
    expect(api.update).toHaveBeenLastCalledWith({ namingTokens: ['{PROD}', '_', 'SC', '{SCENE}', '{SETUP}', '_', 'T', '{TAKE}'] });
    expect(screen.getByText(/_BY_SCENE \/ SCENE_014 \/ SETUP_B \/ NJR_SC14B_T04/)).toBeTruthy();

    expect(screen.getByText('12 clips placed')).toBeTruthy();
    expect(screen.getByText(/2 as reference files/)).toBeTruthy();
    expect(screen.getByText(/A001C002 on SHTL: A different file/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Open on RAID/ }));
    expect(api.showSceneFolder).toHaveBeenCalledWith('/Volumes/RAID/NIGHTJAR/SHOOT_DAY_001_2026-10-06/CAMERA_ORIGINALS/_BY_SCENE');
  });

  it("lists the day's real reports, opens and shows them, and writes the day report", async () => {
    api.reports.mockResolvedValue([
      {
        id: 'ingest:A001',
        step: 'verify',
        screen: 'verify',
        name: 'Ingest verification — A001',
        covers: 'ASC MHL · 12 files · 2 destinations · MD5',
        time: '2026-10-06T14:31:00Z',
        status: 'done',
        word: 'Safe to format',
        card: 'A001',
        files: ['/Volumes/RAID/NIGHTJAR/SHOOT_DAY_001_2026-10-06/CAMERA_ORIGINALS/A001/ascmhl/0001_A001.mhl'],
      },
      { id: 'sync', step: 'sync', screen: 'sync', name: 'Picture and sound sync', covers: '12 clips', time: null, status: 'needs', word: '2 to review', files: [] },
    ]);
    render(
      <StoreProvider>
        <Reports />
      </StoreProvider>,
    );
    expect(await screen.findByText('Ingest verification — A001')).toBeTruthy();
    expect(screen.getByText('Safe to format')).toBeTruthy();
    expect(screen.getByText('2 to review')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show the files of Ingest verification — A001' }));
    expect(api.showReport).toHaveBeenCalledWith('/Volumes/RAID/NIGHTJAR/SHOOT_DAY_001_2026-10-06/CAMERA_ORIGINALS/A001/ascmhl/0001_A001.mhl');
    // The sync report has no file of its own.
    expect(screen.queryByRole('button', { name: 'Show the files of Picture and sound sync' })).toBeNull();

    fireEvent.click(screen.getByRole('group', { name: 'Filter by step' }).querySelector('button:nth-child(5)')!);
    expect(screen.queryByText('Ingest verification — A001')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Write to drives' }));
    expect(api.dayReport).toHaveBeenCalledWith('drives');
    expect(await screen.findByText(/Day report written to 1 drive/)).toBeTruthy();
  });

  it("counts the day's real media in the Files panel, under the folders' real names", () => {
    current = fresh({
      ...logged,
      media: { cameraFiles: 1284, soundFiles: 42, cards: 3, home: 'RAID_07' },
      renders: [{ takeId: '4|A|2', label: '4A-02', clip: 'A001C002', output: '/RAID/x.mov', state: 'done', error: null, lut: null, codec: 'ProRes 422 Proxy', bytes: 1, warnings: [] }],
    });
    render(
      <StoreProvider>
        <FilesPanel />
      </StoreProvider>,
    );
    const row = (name: string) => screen.getByText(name).closest('[role="treeitem"]')!.textContent;
    expect(screen.getByText('RAID_07')).toBeTruthy();
    expect(row('CAMERA_ORIGINALS')).toContain('1,284');
    expect(row('SOUND_ORIGINALS')).toContain('42');
    expect(row('SYNCED_DAILIES')).toContain('1');
    expect(screen.queryByText('01_CAMERA_ORIGINALS')).toBeNull();
    expect(screen.queryByText('1,596')).toBeNull();
  });

  it('keeps the day notes with the shoot day', () => {
    render(
      <StoreProvider>
        <ProjectSetup />
      </StoreProvider>,
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Day notes' }), { target: { value: 'Rain at 15:00; B camera down 40 min.' } });
    expect(api.updateDay).toHaveBeenLastCalledWith({ notes: 'Rain at 15:00; B camera down 40 min.' });
  });
});
