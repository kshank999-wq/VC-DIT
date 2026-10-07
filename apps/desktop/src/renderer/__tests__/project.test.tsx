/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectResult, ProjectState } from '../../shared/project';
import { App } from '../App';
import type { ScreenId } from '../model/types';
import { MatchReview } from '../screens/MatchReview';
import { ProjectSetup } from '../screens/ProjectSetup';
import { SceneOrganizer } from '../screens/SceneOrganizer';
import { SyncWorkspace } from '../screens/SyncWorkspace';
import { VfxHandoff } from '../screens/VfxHandoff';
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
  day: { number: 1, date: '2026-10-06', locations: '', operator: { name: '', initials: '' } },
  days: [{ number: 1, date: '2026-10-06', locations: '', operator: { name: '', initials: '' } }],
  scenes: [],
  log: null,
  matches: [],
  vfx: [],
  vfxActivity: null,
  sync: [],
  syncActivity: null,
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
    addDay: vi.fn(async () => ok(fresh({ day: { number: 2, date: '2026-10-07', locations: '', operator: { name: '', initials: '' } } }))),
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
});
