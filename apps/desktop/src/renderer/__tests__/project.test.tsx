/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectResult, ProjectState } from '../../shared/project';
import { App } from '../App';
import type { ScreenId } from '../model/types';
import { ProjectSetup } from '../screens/ProjectSetup';
import { StoreProvider, useStore } from '../state/store';

/**
 * The screens on the production database: a fresh production opens with
 * nothing of the demo day in it, edits are written through, and days and
 * productions are switched by the database.
 */

const LICENSED = { plan: 'dit', state: 'licensed', email: null, serial: null, paidThrough: null, validUntil: null, message: null };

const fresh = (patch: Partial<ProjectState> = {}): ProjectState => ({
  file: '/data/productions/nightjar.vcdit',
  production: { name: 'NIGHTJAR', code: 'NJR', frameRate: '25 fps', checksum: 'MD5', totalDays: 30, devices: [], namingTokens: ['{PROD}', '_', 'D{DAY}'] },
  day: { number: 1, date: '2026-10-06', locations: '', operator: { name: '', initials: '' } },
  days: [{ number: 1, date: '2026-10-06', locations: '', operator: { name: '', initials: '' } }],
  scenes: [],
  recent: [{ file: '/data/productions/nightjar.vcdit', name: 'NIGHTJAR' }, { file: '/data/productions/halcyon.vcdit', name: 'HALCYON' }],
  ...patch,
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
});
