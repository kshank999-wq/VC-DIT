/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { STEPS } from '../model/status';
import { initialState, StoreProvider } from '../state/store';

const access = (over: Partial<Access> = {}): Access => ({
  plan: 'none',
  state: 'not-activated',
  email: null,
  serial: null,
  paidThrough: null,
  validUntil: null,
  message: null,
  ...over,
});

const host = (current: Access) => {
  const activate = vi.fn(async () => current);
  window.vcdit = {
    platform: 'darwin',
    desktop: true,
    license: { now: () => current, onChange: () => () => {}, activate, refresh: vi.fn(), deactivate: vi.fn(), open: vi.fn() },
  };
  return { activate };
};

const mount = () =>
  render(
    <StoreProvider initial={initialState()} simulate={false}>
      <App />
    </StoreProvider>,
  );

afterEach(() => {
  cleanup();
  delete window.vcdit;
});

describe('the app shell', () => {
  it('shows the six steps, and Today leads with the failed card', () => {
    host(access({ plan: 'dit', state: 'licensed' }));
    mount();
    const flow = screen.getByRole('navigation', { name: 'Pipeline' });
    for (const step of STEPS) expect(within(flow).getByText(step.name)).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('1 card failed its check — fix that first.');
    expect(screen.getByText(/1 problem/)).toBeTruthy();
  });

  it('retrying the failed copy from Today clears the problem everywhere', () => {
    host(access({ plan: 'dit', state: 'licensed' }));
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Today' }));
    expect(screen.queryByText(/problem/)).toBeNull();
  });

  it('navigates by the flow bar and by Ctrl/⌘ + number', () => {
    host(access({ plan: 'dit', state: 'licensed' }));
    mount();
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Pipeline' })).getByText('Audio Sync'));
    expect(screen.getByRole('button', { name: /Audio Sync/ }).getAttribute('aria-current')).toBe('step');
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '3', ctrlKey: true }));
    });
    expect(screen.getByRole('tab', { name: 'Scene Organizer' }).getAttribute('aria-selected')).toBe('true');
  });

  it('asks an unactivated computer for its authorization code, and says so in the header', () => {
    const { activate } = host(access({ message: 'That authorization code was not recognised.' }));
    mount();
    expect(screen.getByRole('alert').textContent).toMatch(/not recognised/);
    fireEvent.change(screen.getByLabelText('Authorization code'), { target: { value: 'VCDIT-AAAAA-BBBBB-CCCCC-DDDDD' } });
    fireEvent.click(screen.getByRole('button', { name: 'Activate this computer' }));
    expect(activate).toHaveBeenCalledWith('VCDIT-AAAAA-BBBBB-CCCCC-DDDDD');
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    expect(screen.getByText('Not activated')).toBeTruthy();
  });

  it('does not ask a licensed one', () => {
    host(access({ plan: 'dit', state: 'licensed' }));
    mount();
    expect(screen.queryByLabelText('Authorization code')).toBeNull();
  });
});
