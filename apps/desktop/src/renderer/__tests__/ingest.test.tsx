/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Intake } from '../screens/Intake';
import { ProjectSetup } from '../screens/ProjectSetup';
import { Reports } from '../screens/Reports';
import { Verify } from '../screens/Verify';
import { initialState, StoreProvider, useStore, type AppState } from '../state/store';

/** Shows the store's current screen, so a test can see where a button went. */
function Where() {
  const { state } = useStore();
  return <output data-testid="where">{state.screen}</output>;
}

const mount = (ui: React.ReactNode, initial: AppState = initialState()) =>
  render(
    <StoreProvider initial={initial} simulate={false}>
      {ui}
      <Where />
    </StoreProvider>,
  );

beforeEach(() => {
  window.vcdit = {
    platform: 'darwin',
    desktop: true,
    license: {
      now: () => ({ plan: 'dit', state: 'licensed', email: null, serial: null, paidThrough: null, validUntil: null, message: null }),
      onChange: () => () => {},
      activate: async () => ({ plan: 'dit', state: 'licensed', email: null, serial: null, paidThrough: null, validUntil: null, message: null }),
      refresh: async () => ({ plan: 'dit', state: 'licensed', email: null, serial: null, paidThrough: null, validUntil: null, message: null }),
      deactivate: async () => ({ plan: 'none', state: 'not-activated', email: null, serial: null, paidThrough: null, validUntil: null, message: null }),
      open: () => {},
    } as unknown as NonNullable<Window['vcdit']>['license'],
  };
});

afterEach(() => {
  cleanup();
  delete window.vcdit;
});

describe('Project setup', () => {
  it('edits the production and sets a scene status from a real select', () => {
    mount(<ProjectSetup />);
    const name = screen.getByRole('textbox', { name: 'Production' }) as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'NIGHTJAR' } });
    expect(name.value).toBe('NIGHTJAR');
    expect(screen.getByText(/NIGHTJAR \/ SHOOT_DAY_014/)).toBeTruthy();

    const status = screen.getByLabelText('Scene 15 status') as HTMLSelectElement;
    fireEvent.change(status, { target: { value: 'Shooting' } });
    expect(status.value).toBe('Shooting');
  });

  it('adds a scene, and will not add the same one twice', () => {
    mount(<ProjectSetup />);
    fireEvent.change(screen.getByLabelText('New scene number'), { target: { value: '23' } });
    fireEvent.change(screen.getByLabelText('New scene description'), { target: { value: 'EXT. HANGAR – NIGHT' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add scene' }));
    expect(screen.getByLabelText('Scene 23 status')).toBeTruthy();
    expect(screen.getByText('EXT. HANGAR – NIGHT')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('New scene number'), { target: { value: '23' } });
    expect((screen.getByRole('button', { name: 'Add scene' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('counts matched and review entries from the open matches', () => {
    mount(<ProjectSetup />);
    expect(screen.getByText('Matched').previousSibling?.textContent).toBe('61');
    expect(screen.getByText('Review').previousSibling?.textContent).toBe('3');
  });
});

describe('Intake', () => {
  it('never lists a camera card as a destination', () => {
    mount(<Intake />);
    const out = screen.getByRole('region', { name: 'Destinations' });
    expect(within(out).queryByText('A015')).toBeNull();
    expect(within(out).getByText('SHTL_08')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Role of SHTL_08'), { target: { value: 'Camera' } });
    expect(within(out).queryByText('SHTL_08')).toBeNull();
  });

  it('says why it cannot start, and warns (without blocking) on a single destination', () => {
    mount(<Intake />);
    for (const name of ['HLC_RAID_01', 'SHTL_07', 'PROD_NAS']) fireEvent.click(screen.getByLabelText(`Write to ${name}`));
    const start = screen.getByRole('button', { name: 'Start verified ingest' }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(screen.getByText(/Pick at least one destination/)).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Write to HLC_RAID_01'));
    expect(start.disabled).toBe(false);
    expect(screen.getByText('Only one destination')).toBeTruthy();
  });

  it('starts the ingest with the chosen checksum and goes to Verify', () => {
    mount(<Intake />);
    fireEvent.click(screen.getByRole('button', { name: /MD5/ }));
    expect(screen.getByRole('button', { name: /MD5/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('3 sources → 3 destinations')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Start verified ingest' }));
    expect(screen.getByTestId('where').textContent).toBe('verify');
  });
});

describe('Verify', () => {
  it('puts the problem card first, never offers to format, and retry clears the problem', () => {
    mount(<Verify />);
    const cards = screen.getAllByRole('region');
    expect(cards[0]!.getAttribute('aria-label')).toBe('Card A013');
    expect(within(cards[0]!).getByText("Problem — don't format")).toBeTruthy();
    expect(screen.getByText(/cards safe to format/).textContent).toMatch(/^2 of 5 cards safe to format · 1 problem/);
    expect(screen.queryByRole('button', { name: /format|delete|erase/i })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry copy A013 → SHTL_06' }));
    expect(screen.queryByText("Problem — don't format")).toBeNull();
    expect(screen.getByRole('region', { name: 'Card A013' }).textContent).toMatch(/Not safe yet|Waiting/);
  });
});

describe('Reports', () => {
  it('filters by step and opens the source screen', () => {
    mount(<Reports />);
    fireEvent.click(screen.getByRole('button', { name: 'VFX' }));
    expect(screen.getAllByRole('row')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Open VFX mirror report' }));
    expect(screen.getByTestId('where').textContent).toBe('vfx');
  });

  it('takes the A013 row from the live transfer, so it never contradicts Verify', () => {
    const fixed = initialState();
    fixed.jobs = fixed.jobs.map((job) => (job.id === 'A013' ? { ...job, legs: job.legs.map((leg) => ({ ...leg, failed: false })) } : job));
    mount(<Reports />, fixed);
    const row = screen.getByText('Ingest verification — A013').closest('tr')!;
    expect(within(row).getByText('Complete')).toBeTruthy();
    cleanup();

    mount(<Reports />);
    const failed = screen.getByText('Ingest verification — A013').closest('tr')!;
    expect(within(failed).getByText('Problem')).toBeTruthy();
  });
});
