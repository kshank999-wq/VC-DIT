/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { MatchReview } from '../screens/MatchReview';
import { SceneOrganizer } from '../screens/SceneOrganizer';
import { VfxHandoff } from '../screens/VfxHandoff';
import { initialState, StoreProvider, type AppState } from '../state/store';

const mount = (node: ReactNode, patch: Partial<AppState> = {}) =>
  render(
    <StoreProvider initial={{ ...initialState(), ...patch }} simulate={false}>
      {node}
    </StoreProvider>,
  );

afterEach(cleanup);

const thumbs = () => within(screen.getByRole('group', { name: /Takes/ })).getAllByRole('button');
const pressed = () => thumbs().find((button) => button.getAttribute('aria-pressed') === 'true');

describe('Scene Organizer', () => {
  it('shows the selected setup and selects the first take by default', () => {
    mount(<SceneOrganizer />);
    expect(screen.getByText('Scene 14 / Setup B')).toBeTruthy();
    expect(thumbs()).toHaveLength(5);
    expect(pressed()?.textContent).toContain('A014C019');
    expect(screen.getByText('01_CAMERA_ORIGINALS / SCENE_014 / SETUP_B')).toBeTruthy();
  });

  it('filters circle takes as a view: every take is still kept', () => {
    mount(<SceneOrganizer />);
    fireEvent.click(screen.getByRole('button', { name: /Circle takes/ }));
    expect(thumbs()).toHaveLength(2);
    expect(thumbs().every((button) => button.textContent?.includes('SELECT'))).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /All clips/ }));
    expect(thumbs()).toHaveLength(5);
  });

  it('says plainly when a filter is empty and offers the way back', () => {
    mount(<SceneOrganizer />);
    fireEvent.click(screen.getByRole('button', { name: /VFX shots/ }));
    expect(screen.getByText(/No vfx shots in Scene 14 \/ Setup B\. All 5 takes are still kept\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show all clips' }));
    expect(thumbs()).toHaveLength(5);
  });

  it('moves between takes with the arrow keys', () => {
    mount(<SceneOrganizer />);
    fireEvent.keyDown(pressed()!, { key: 'ArrowRight' });
    expect(pressed()?.textContent).toContain('A014C020');
    fireEvent.keyDown(pressed()!, { key: 'ArrowLeft' });
    expect(pressed()?.textContent).toContain('A014C019');
  });

  it('switches setup from the scene bins and toggles the look', () => {
    mount(<SceneOrganizer />);
    fireEvent.click(screen.getAllByRole('button', { name: /Setup C/ })[0]!);
    expect(screen.getByText('Scene 14 / Setup C')).toBeTruthy();
    expect(thumbs()).toHaveLength(2);
    const look = screen.getByRole('button', { name: /LOOK ON/ });
    fireEvent.click(look);
    expect(screen.getByRole('button', { name: 'LOOK OFF · LOG' }).getAttribute('aria-pressed')).toBe('false');
  });
});

describe('Match Review', () => {
  it('counts open items, confirms and advances to the next one', () => {
    mount(<MatchReview />);
    expect(screen.getByRole('heading', { name: '3 items need a decision' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm match' }));
    expect(screen.getByRole('heading', { name: '2 items need a decision' })).toBeTruthy();
    // The next open item is now shown: Sc 14 / C / T02's reason.
    expect(screen.getAllByText(/Possible reel mislabel/).length).toBe(2);
  });

  it('shows the outcome of a resolved item instead of the actions', () => {
    mount(<MatchReview />);
    fireEvent.click(screen.getByRole('button', { name: 'Mark unslated / wild' }));
    fireEvent.click(screen.getByRole('button', { name: /Sc 14 \/ B \/ T04/ }));
    expect(screen.queryByRole('button', { name: 'Confirm match' })).toBeNull();
    expect(screen.getByText(/marked unslated \/ wild/)).toBeTruthy();
  });

  it('lets the DIT pick another candidate', () => {
    mount(<MatchReview />);
    const radio = screen.getByRole('radio', { name: /A014C019/ }) as HTMLInputElement;
    fireEvent.click(radio);
    expect(radio.checked).toBe(true);
  });

  it('says All matched when nothing is left', () => {
    mount(<MatchReview />, {
      matches: initialState().matches.map((match) => ({ ...match, resolution: { kind: 'wild' } as const })),
    });
    expect(screen.getByRole('heading', { name: 'All matched' })).toBeTruthy();
  });
});

describe('VFX Handoff', () => {
  it('shows paths for the selected shot and explains the mirror method', () => {
    mount(<VfxHandoff />);
    expect(screen.getByText('…/CAMERA_ORIGINALS/SCENE_021/SETUP_A/A015C007')).toBeTruthy();
    expect(screen.getByText('…/VFX/SCENE_021/SETUP_A/A015C007')).toBeTruthy();
    expect(screen.getByText(/no extra storage/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Physical copy' }));
    expect(screen.getByText(/uses storage/)).toBeTruthy();
    expect(screen.getByText('VFX mirror · Physical copy')).toBeTruthy();
  });

  it('links blocked rows to Match Review', () => {
    mount(<VfxHandoff />);
    expect(screen.getByRole('button', { name: /Waiting on Match Review/ })).toBeTruthy();
  });

  it('tags a new candidate from today’s media and refuses unknown clips', () => {
    mount(<VfxHandoff />);
    fireEvent.click(screen.getByRole('button', { name: '+ Tag additional VFX candidate' }));
    fireEvent.change(screen.getByLabelText('Clip'), { target: { value: 'NOPE001' } });
    expect(screen.getByText(/No clip named NOPE001/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Tag' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Clip'), { target: { value: 'A014C020' } });
    fireEvent.change(screen.getByLabelText('VFX note'), { target: { value: 'Sky check' } });
    fireEvent.click(screen.getByRole('button', { name: 'Tag' }));
    expect(screen.getAllByText('A014C020').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Sky check').length).toBeGreaterThan(0);
  });

  it('sends eligible shots to prep, then says why the button is off', () => {
    mount(<VfxHandoff />, { vfx: initialState().vfx.filter((shot) => shot.prep !== 'blocked') });
    fireEvent.click(screen.getByRole('button', { name: /Send 7 to VC VFX Prep/ }));
    expect(screen.getAllByText('Sent to prep')).toHaveLength(7);
    expect(screen.getByText('Every shot has been sent to prep.')).toBeTruthy();
  });
});
