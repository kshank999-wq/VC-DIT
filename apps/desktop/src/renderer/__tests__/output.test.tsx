/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Dailies } from '../screens/Dailies';
import { Delivery } from '../screens/Delivery';
import { Looks } from '../screens/Looks';
import { SyncWorkspace } from '../screens/SyncWorkspace';
import { initialState, StoreProvider, useStore, type AppState } from '../state/store';

/** Shows the current screen id, so a test can see navigation. */
function ScreenProbe() {
  const { state } = useStore();
  return <output data-testid="screen">{state.screen}</output>;
}

const mount = (node: ReactNode, initial: AppState = initialState()) =>
  render(
    <StoreProvider initial={initial} simulate={false}>
      {node}
      <ScreenProbe />
    </StoreProvider>,
  );

afterEach(() => {
  cleanup();
  delete window.vcdit;
});

describe('Audio Sync', () => {
  it('nudges the selected take and accepts it', () => {
    mount(<SyncWorkspace />);
    expect(screen.getByText('2 takes still need review.')).toBeTruthy();
    const top = screen.getByRole('region', { name: 'Sync for 14B-04' });
    expect(within(top).getByText('−3 fr')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Nudge sound one frame later' }));
    expect(within(top).getByText('−2 fr')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Accept sync' }));
    expect(screen.getByText('1 take still needs review.')).toBeTruthy();
    // Selection moves on to the one left: 14C-02, with no timecode.
    expect(screen.getByRole('region', { name: 'Sync for 14C-02' })).toBeTruthy();
  });

  it('selects a row from the table and shows its status', () => {
    mount(<SyncWorkspace />);
    const row = screen.getByText('21A-01').closest('tr')!;
    fireEvent.click(row);
    expect(row.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('button', { name: 'Accepted' })).toHaveProperty('disabled', true);
    expect(within(screen.getByText('14C-02').closest('tr')!).getByText('No TC')).toBeTruthy();
  });

  it('runs a waveform pass on the take without timecode', () => {
    mount(<SyncWorkspace />);
    fireEvent.click(screen.getByRole('button', { name: 'Waveform pass on exceptions' }));
    const row = screen.getByText('14C-02').closest('tr')!;
    expect(within(row).getByText('Waveform')).toBeTruthy();
    expect(within(row).getByText('78%')).toBeTruthy();
    expect(within(row).getByText('Review')).toBeTruthy();
  });
});

describe('Looks', () => {
  it('picks a LUT and moves the split', () => {
    mount(<Looks />);
    const night = screen.getByRole('option', { name: /HLC_Night_Ext_v2/ });
    fireEvent.click(night);
    expect(night.getAttribute('aria-selected')).toBe('true');
    expect(screen.getAllByText('HLC_Night_Ext_v2.cube').length).toBeGreaterThan(1);
    const range = screen.getByLabelText('Split between viewing look and original') as HTMLInputElement;
    fireEvent.change(range, { target: { value: '30' } });
    expect(range.value).toBe('30');
    expect(screen.getByText(/never baked/)).toBeTruthy();
  });
});

describe('Dailies', () => {
  it('changes options, builds, and goes on to delivery', () => {
    mount(<Dailies />);
    fireEvent.click(screen.getByRole('button', { name: /All takes/ }));
    expect(screen.getByText('36 clips · ~52 min · ≈ 86 GB')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Codec'), { target: { value: 'DNxHD 36' } });
    expect((screen.getByLabelText('Codec') as HTMLSelectElement).value).toBe('DNxHD 36');
    const notes = screen.getByRole('button', { name: 'Notes' });
    fireEvent.click(notes);
    expect(screen.getByRole('button', { name: '✓ Notes' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Build dailies' }));
    expect(screen.getByText('Built · ready to deliver')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Go to Delivery →' }));
    expect(screen.getByTestId('screen').textContent).toBe('delivery');
  });

  it('previews the Frame.io tree from the circle takes', () => {
    mount(<Dailies />);
    const tree = screen.getByLabelText('Frame.io folder structure').textContent!;
    expect(tree).toContain('Day 014 — 2026-10-05/');
    expect(tree).toContain('Sc 014/');
    expect(tree).toContain('14A_T02 ◎.mov');
    expect(tree).not.toContain('Sc 015/');
  });
});

describe('Delivery', () => {
  it('passes preflight for the default selection and delivers', () => {
    mount(<Delivery />);
    expect(screen.getByText('1.30 TB → 2 destinations')).toBeTruthy();
    expect(screen.getByText('✓ 204 GB left')).toBeTruthy();
    expect(screen.getByText('✓ ready')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Deliver & verify' }));
    expect(screen.getByText('Delivered · 3 packages verified')).toBeTruthy();
  });

  it('blocks delivery when a destination is short of space, and says why', () => {
    mount(<Delivery />);
    fireEvent.click(screen.getByLabelText('Camera originals archive'));
    expect(screen.getByText('✕ short 4.62 TB')).toBeTruthy();
    const deliver = screen.getByRole('button', { name: 'Deliver & verify' }) as HTMLButtonElement;
    expect(deliver.disabled).toBe(true);
    expect(screen.getByText(/Not enough space on EDIT_SHTL_03/)).toBeTruthy();
    // Moving the delivery to the archive instead clears it.
    fireEvent.click(screen.getByLabelText('EDIT_SHTL_03'));
    fireEvent.click(screen.getByLabelText('ARCHIVE_NAS'));
    expect((screen.getByRole('button', { name: 'Deliver & verify' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('asks for a package before it can deliver', () => {
    mount(<Delivery />);
    for (const name of ['Editorial handoff', 'Synced dailies', 'Reports & logs']) fireEvent.click(screen.getByLabelText(name));
    expect((screen.getByRole('button', { name: 'Deliver & verify' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText('Choose at least one package.').length).toBeGreaterThan(0);
  });

  it("lists yesterday's manifest with the retry flagged", () => {
    mount(<Delivery />);
    expect(screen.getByText('Delivery manifest · Day 013')).toBeTruthy();
    expect(screen.getByText('↻ 1 retry · OK')).toBeTruthy();
  });
});
