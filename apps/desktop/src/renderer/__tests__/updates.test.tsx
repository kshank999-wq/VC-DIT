/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UpdateState } from '../../shared/updates';
import { UpdateCheck, UpdateNotice } from '../ui/UpdateNotice';

const state = (over: Partial<UpdateState> = {}): UpdateState => ({
  current: '0.1.0',
  available: { version: '0.2.0', notes: 'Frame.io publishing.\nFaster ingest.', minimumOs: 'Windows 10', publishedAt: null },
  showing: true,
  checking: false,
  checkedAt: '2026-10-16T09:00:00Z',
  error: null,
  ...over,
});

const install = (initial: UpdateState) => {
  let listener: ((next: UpdateState) => void) | null = null;
  const updates = {
    now: () => initial,
    onChange: (next: (value: UpdateState) => void) => {
      listener = next;
      return () => undefined;
    },
    check: vi.fn(async () => initial),
    dismiss: vi.fn(async () => initial),
  };
  const open = vi.fn(async () => undefined);
  window.vcdit = { platform: 'win32', desktop: true, license: { open } as unknown as NonNullable<Window['vcdit']>['license'], updates };
  return { updates, open, push: (next: UpdateState) => act(() => listener?.(next)) };
};

afterEach(() => {
  cleanup();
  delete window.vcdit;
});

describe('a newer VC DIT', () => {
  it('says which version, what is new, and offers download, later or skip', () => {
    const { updates, open, push } = install(state());
    render(<UpdateNotice />);
    expect(screen.getByText('VC DIT 0.2.0 is available')).toBeTruthy();
    expect(screen.getByText('You have 0.1.0. Frame.io publishing. Faster ingest. Needs Windows 10 or later.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    expect(open).toHaveBeenCalledWith('download');
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    expect(updates.dismiss).toHaveBeenLastCalledWith('later');
    fireEvent.click(screen.getByRole('button', { name: 'Skip this version' }));
    expect(updates.dismiss).toHaveBeenLastCalledWith('skip');
    // Put off: the notice goes.
    push(state({ showing: false }));
    expect(screen.queryByText('VC DIT 0.2.0 is available')).toBeNull();
  });

  it('shows nothing when up to date, or where there is no update check', () => {
    install(state({ available: null, showing: false }));
    const { container } = render(<UpdateNotice />);
    expect(container.textContent).toBe('');
    cleanup();
    delete window.vcdit;
    expect(render(<UpdateNotice />).container.textContent).toBe('');
  });

  it('checks on demand in Preferences and says what it found', () => {
    const { updates, push } = install(state({ available: null, showing: false, checkedAt: null }));
    render(<UpdateCheck />);
    expect(screen.getByText('0.1.0')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    expect(updates.check).toHaveBeenCalled();
    push(state({ available: null, showing: false, checking: true, checkedAt: null }));
    expect(screen.getByText('Checking…')).toBeTruthy();
    push(state({ available: null, showing: false }));
    expect(screen.getByText('This is the latest version.')).toBeTruthy();
    push(state({ available: null, showing: false, error: 'VC DIT could not reach vc-dit.com.' }));
    expect(screen.getByText('VC DIT could not reach vc-dit.com.')).toBeTruthy();
    push(state());
    expect(screen.getByRole('button', { name: 'Download 0.2.0' })).toBeTruthy();
  });
});
