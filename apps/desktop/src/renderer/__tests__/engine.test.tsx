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
};
const raid = { ...card, id: '/Volumes/RAID', name: 'RAID', mountPath: '/Volumes/RAID', detected: 'VC DIT media drive', role: 'Destination' as const, suggestedRole: 'Destination' as const };

const job = (patch: Partial<JobSnapshot['legs'][number]> = {}): JobSnapshot => ({
  id: 'A015',
  label: 'ARRI · ARRIRAW',
  sourceId: card.id,
  totalBytes: 7e11,
  fileCount: 1284,
  queued: false,
  running: true,
  checksum: 'xxHash64',
  legs: [{ id: raid.id, name: 'RAID', copyPct: 40, verifyPct: 0, failed: false, error: null, problemFiles: 0, targetDir: '/Volumes/RAID/HALCYON/A015', ...patch }],
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
    state: vi.fn(async () => ({ volumes: [card, raid], folders: [], jobs: [] })),
    onChange: vi.fn((next: (state: MediaState) => void) => {
      listener = next;
      return () => (listener = null);
    }),
    setRole: vi.fn(async () => ({ ok: true })),
    addFolder: vi.fn(async () => ({ ok: true })),
    removeFolder: vi.fn(async () => undefined),
    ingest: vi.fn(async () => ({ ok: true, jobs: ['A015'] })),
    retry: vi.fn(async () => ({ ok: true, jobs: ['A015'] })),
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
    expect(sources.textContent).toContain('USB drive · 1.0 TB · 700 GB used · ExFAT');
    // The RAID, marked Destination, is offered on the right and already picked.
    const out = screen.getByRole('region', { name: 'Destinations' });
    expect((within(out).getByRole('checkbox', { name: 'Write to RAID' }) as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /Start verified ingest/ }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('verify'));
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

  it('says what to do when nothing is plugged in', async () => {
    media.state.mockResolvedValueOnce({ volumes: [], folders: [], jobs: [] });
    mount(<Intake />);
    expect(await screen.findByText(/No cards or drives found/)).toBeTruthy();
  });
});

describe('Verify on the media engine', () => {
  it('shows real progress, speed and time left', async () => {
    mount(<Verify />);
    await waitFor(() => expect(media.state).toHaveBeenCalled());
    push({ volumes: [card, raid], folders: [], jobs: [job()] });
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
      jobs: [{ ...job({ copyPct: 100, verifyPct: 100, failed: true, error: 'The destination was disconnected.' }), running: false }],
    });
    expect(screen.getByText(/Problem — don't format/)).toBeTruthy();
    expect(screen.getByText('The destination was disconnected.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry copy A015 → RAID' }));
    expect(media.retry).toHaveBeenCalledWith('A015', raid.id);
  });

  it('calls a card safe to format only when every destination verified', async () => {
    mount(<Verify />);
    await waitFor(() => expect(media.state).toHaveBeenCalled());
    push({ volumes: [card, raid], folders: [], jobs: [{ ...job({ copyPct: 100, verifyPct: 100 }), running: false, bytesPerSecond: 0 }] });
    expect(screen.getByText('Safe to format')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(media.show).toHaveBeenCalledWith('/Volumes/RAID/HALCYON/A015');
  });
});
