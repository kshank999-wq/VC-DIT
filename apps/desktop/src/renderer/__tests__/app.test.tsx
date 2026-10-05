/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { SCREENS } from '../screens';

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

afterEach(() => {
  cleanup();
  delete window.vcdit;
});

describe('the app shell', () => {
  it('lists every screen of the spec and switches between them', () => {
    host(access({ plan: 'dit', state: 'licensed' }));
    render(<App />);
    for (const candidate of SCREENS) expect(screen.getByRole('button', { name: candidate.name })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sync Workspace' }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Sync Workspace');
  });

  it('asks an unactivated computer for its authorization code', () => {
    const { activate } = host(access({ message: 'That authorization code was not recognised.' }));
    render(<App />);
    expect(screen.getByRole('alert').textContent).toMatch(/not recognised/);
    fireEvent.change(screen.getByLabelText('Authorization code'), { target: { value: 'VCDIT-AAAAA-BBBBB-CCCCC-DDDDD' } });
    fireEvent.click(screen.getByRole('button', { name: 'Activate this computer' }));
    expect(activate).toHaveBeenCalledWith('VCDIT-AAAAA-BBBBB-CCCCC-DDDDD');
  });

  it('does not ask a licensed one', () => {
    host(access({ plan: 'dit', state: 'licensed' }));
    render(<App />);
    expect(screen.queryByLabelText('Authorization code')).toBeNull();
  });
});
