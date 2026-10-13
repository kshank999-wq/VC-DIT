/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StoreProvider } from '../state/store';
import { MissingCopiesPanel } from '../ui/Relink';
import { fresh } from './fixtures';

afterEach(() => {
  cleanup();
  delete window.vcdit;
});

describe('copies not where they were', () => {
  it('lists drives whose copies moved, finds them on request, and says what it found', async () => {
    const drive = { name: 'RAID', root: 'E:\\', copies: 3, cards: ['A015', 'A016', 'B004'], days: [1, 2] };
    const relinkScan = vi.fn().mockResolvedValueOnce([drive]).mockResolvedValue([]);
    const relink = vi.fn(async () => ({ ok: true as const, found: 2, missing: ['B004 (day 2)'], place: 'F:\\' }));
    window.vcdit = { platform: 'win32', desktop: true, project: { now: () => fresh(), onChange: () => () => undefined, relinkScan, relink } } as unknown as Window['vcdit'];
    render(
      <StoreProvider>
        <MissingCopiesPanel />
      </StoreProvider>,
    );
    const panel = await screen.findByRole('region', { name: 'Copies not where they were' });
    expect(panel.textContent).toMatch(/RAID · was E:\\ · 3 card copies \(A015, A016, B004\) · days 1, 2/);
    fireEvent.click(screen.getByRole('button', { name: 'Find…' }));
    await waitFor(() => expect(relink).toHaveBeenCalledWith('RAID', 'E:\\'));
    expect((await screen.findByRole('status')).textContent).toBe('2 copies of RAID found in F:\\ and checked. Still not found: B004 (day 2).');
    // Scanned again: nothing left to find, and the panel goes, keeping what it said.
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Copies not where they were' })).toBeNull());
    expect(screen.getByRole('status').textContent).toMatch(/2 copies of RAID found/);
  });

  it('shows nothing when every copy is where it was', async () => {
    const relinkScan = vi.fn(async () => []);
    window.vcdit = { platform: 'darwin', desktop: true, project: { now: () => fresh(), onChange: () => () => undefined, relinkScan } } as unknown as Window['vcdit'];
    const { container } = render(
      <StoreProvider>
        <MissingCopiesPanel />
      </StoreProvider>,
    );
    await waitFor(() => expect(relinkScan).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});
