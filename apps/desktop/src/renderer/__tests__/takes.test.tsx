/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Takes } from '../screens/Takes';
import { fresh } from './fixtures';
import { initialState, StoreProvider, useStore, type AppState } from '../state/store';

function ScreenProbe() {
  const { state } = useStore();
  return <output data-testid="screen">{state.screen}</output>;
}

const mount = (initial: AppState = initialState()) =>
  render(
    <StoreProvider initial={initial} simulate={false}>
      <Takes />
      <ScreenProbe />
    </StoreProvider>,
  );

const row = (clip: string) => screen.getByText(clip, { selector: 'td' }).closest('tr') as HTMLElement;

afterEach(() => {
  cleanup();
  delete window.vcdit;
});

describe('Assign takes', () => {
  it('shows each clip, where it goes and who says so, with the clips the sources disagree on sent to Match Review', () => {
    mount();
    expect(within(row('A015C001')).getByText('Script log')).toBeTruthy();
    expect(row('A015C001').textContent).toContain('Sc 14 / B / T01');
    expect(within(row('A015C004')).getAllByText('Camera report').length).toBeGreaterThan(0);
    expect(within(row('A015C005')).getAllByText('Sound slate').length).toBeGreaterThan(0);
    expect(row('A015C006').textContent).toContain('Not placed');
    fireEvent.click(within(row('A015C003')).getByRole('button', { name: 'Disagree · decide' }));
    expect(screen.getByTestId('screen').textContent).toBe('match');
  });

  it('places ticked clips by hand, one take each, and the next run carries on from there', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /^Not placed/ }));
    fireEvent.click(within(row('A015C006')).getByRole('checkbox', { name: 'Pick A015C006' }));
    fireEvent.click(within(row('A015C003')).getByRole('checkbox', { name: 'Pick A015C003' }));
    fireEvent.change(screen.getByLabelText('Scene'), { target: { value: '22' } });
    fireEvent.change(screen.getByLabelText('Setup'), { target: { value: 'a' } });
    fireEvent.change(screen.getByLabelText('Take'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Assign 2' }));
    fireEvent.click(screen.getByRole('button', { name: /^All/ }));
    expect(row('A015C003').textContent).toContain('Sc 22 / A / T03');
    expect(row('A015C006').textContent).toContain('Sc 22 / A / T04');
    expect(within(row('A015C006')).getByText('You')).toBeTruthy();
    expect((screen.getByLabelText('Take') as HTMLInputElement).value).toBe('5');
  });

  it('in the desktop app, sends assignments and the camera report to the production', async () => {
    const state = { ...initialState(), project: { file: '/p.vcdit', days: [], recent: [] } } as AppState;
    const assign = vi.fn(async () => ({ ok: false as const, reason: 'stop here' }));
    const setCameraReport = vi.fn(async (_card: string, _rows: { clip: string; take: string; scene: string; setup: string }[]) => ({ ok: false as const, reason: '' }));
    window.vcdit = { platform: 'darwin', desktop: true, project: { onChange: () => () => undefined, assign, setCameraReport, importCameraReport: vi.fn(), saveReportTemplate: vi.fn() } } as unknown as Window['vcdit'];
    mount(state);
    fireEvent.click(within(row('A015C006')).getByRole('checkbox', { name: 'Pick A015C006' }));
    fireEvent.change(screen.getByLabelText('Scene'), { target: { value: '22' } });
    fireEvent.click(screen.getByRole('button', { name: 'Assign 1' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith([{ card: 'A015', clip: 'A015C006' }], { scene: '22', setup: '', take: '1', circle: false }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/stop here/);

    // The camera report: a run of clips, one take each, saved for the card.
    const report = screen.getByRole('region', { name: 'Camera report' });
    fireEvent.change(within(report).getByLabelText('Run from clip'), { target: { value: 'C005' } });
    fireEvent.change(within(report).getByLabelText('Run to clip'), { target: { value: 'C006' } });
    fireEvent.change(within(report).getByLabelText('Run scene'), { target: { value: '14' } });
    fireEvent.change(within(report).getByLabelText('Run setup'), { target: { value: 'C' } });
    fireEvent.change(within(report).getByLabelText('Run first take'), { target: { value: '2' } });
    fireEvent.click(within(report).getByRole('button', { name: '+ Run' }));
    fireEvent.click(within(report).getByRole('button', { name: 'Save A015' }));
    const [card, rows] = setCameraReport.mock.calls[0]!;
    expect(card).toBe('A015');
    expect(rows.slice(-2).map((line) => [line.clip, line.scene, line.setup, line.take])).toEqual([
      ['C005', '14', 'C', '2'],
      ['C006', '14', 'C', '3'],
    ]);
  });

  it('gets the camera report from Film Studio and says what it did', async () => {
    const state = { ...initialState(), project: { file: '/p.vcdit', days: [], recent: [] } } as AppState;
    const pullCameraReport = vi.fn(async () => ({ ok: true as const, state: fresh(), note: 'From Film Studio: 4 lines on 1 roll (A015).' }));
    window.vcdit = { platform: 'darwin', desktop: true, project: { onChange: () => () => undefined, pullCameraReport } } as unknown as Window['vcdit'];
    mount(state);
    const report = screen.getByRole('region', { name: 'Camera report' });
    fireEvent.click(within(report).getByRole('button', { name: 'Get from Film Studio' }));
    await waitFor(() => expect(pullCameraReport).toHaveBeenCalled());
    expect(await screen.findByText(/4 lines on 1 roll/)).toBeTruthy();
  });

  it('shows the folders read back on every drive, and puts back what is wrong', async () => {
    const state = {
      ...initialState(),
      project: { file: '/p.vcdit', days: [], recent: [] },
      organize: {
        placed: 6,
        references: 0,
        failed: 0,
        pending: 0,
        folders: [],
        problems: [],
        activity: null,
        check: {
          checkedAt: '2026-10-07T18:00:00.000Z',
          destinations: [
            { destination: 'RAID', clips: 3, ok: 3 },
            { destination: 'LucidLink', clips: 3, ok: 2 },
          ],
          findings: [{ clip: 'A015C001', destination: 'LucidLink', folder: 'CAMERA_ORIGINALS/_BY_SCENE/SCENE_014/SETUP_A/T01', problem: 'missing', detail: 'The reference file is not there.' }],
          total: 1,
        },
      },
    } as AppState;
    const repairSceneFolders = vi.fn(async () => ({ ok: false as const, reason: '' }));
    window.vcdit = { platform: 'darwin', desktop: true, project: { onChange: () => () => undefined, repairSceneFolders, checkSceneFolders: vi.fn() } } as unknown as Window['vcdit'];
    mount(state);
    const panel = screen.getByRole('region', { name: 'Scene folders on every drive' });
    expect(panel.textContent).toContain('3/3 in place');
    expect(panel.textContent).toContain('2/3 in place');
    expect(within(panel).getByRole('alert').textContent).toMatch(/A015C001 on LucidLink: missing/);
    fireEvent.click(within(panel).getByRole('button', { name: 'Put back 1' }));
    await waitFor(() => expect(repairSceneFolders).toHaveBeenCalled());
  });
});
