import { useEffect, useState } from 'react';
import { STEPS } from './model/status';
import { SCREENS } from './screens';
import { FilesPanel } from './shell/FilesPanel';
import { FlowBar, SubTabs } from './shell/FlowBar';
import { Header } from './shell/Header';
import { LicenseDialog } from './shell/License';
import type { ScreenId } from './model/types';
import { useStore } from './state/store';
import { useAccess } from './ui/kit';

/** Screens still (wholly or partly) on the HALCYON sample day in the desktop app, and what they wait for. */
const SAMPLE: Partial<Record<ScreenId, string>> = {
  sync: 'This screen shows the HALCYON demo day until picture and sound sync is built.',
  looks: 'This screen shows the HALCYON demo day until the LUT library is built.',
  dailies: 'This screen shows the HALCYON demo day until dailies rendering is built.',
  delivery: 'This screen shows the HALCYON demo day until the delivery engine is built.',
  reports: 'This screen shows the HALCYON demo day until the reports list is built.',
};
const PARTLY: Partial<Record<ScreenId, string>> = {
  vfx: "The VFX flags are your script supervisor's. Mirroring them into VFX folders and the VC VFX Prep handoff are not built yet.",
};

/** Light, dark, or the system's, on the document so every token switches at once. */
const useTheme = (choice: 'light' | 'dark' | 'system') => {
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    const apply = () => {
      const theme = choice === 'system' ? (media?.matches ? 'dark' : 'light') : choice;
      document.documentElement.dataset['theme'] = theme;
    };
    apply();
    media?.addEventListener?.('change', apply);
    return () => media?.removeEventListener?.('change', apply);
  }, [choice]);
};

export function App() {
  const { state, dispatch } = useStore();
  const access = useAccess();
  // An unactivated copy asks once at start; after that the header's chip opens it.
  const [licenseOpen, setLicenseOpen] = useState(() => access.plan === 'none');
  useTheme(state.theme);

  // Ctrl/⌘ 1–6 jump to the steps, 0 to Today.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (event.key === '0') {
        event.preventDefault();
        dispatch({ type: 'go', screen: 'today' });
        return;
      }
      const step = STEPS[Number(event.key) - 1];
      if (step) {
        event.preventDefault();
        dispatch({ type: 'go', screen: step.screen });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dispatch]);

  // Development only: lets a screenshot script open any screen.
  useEffect(() => {
    if (!import.meta.env.DEV) return undefined;
    (window as unknown as { __vcditGo?: (screen: string) => void }).__vcditGo = (screen) => dispatch({ type: 'go', screen: screen as keyof typeof SCREENS });
    return undefined;
  }, [dispatch]);

  const Screen = SCREENS[state.screen];
  return (
    <div className={`app${state.filesOpen ? '' : ' files-closed'}`}>
      <Header onLicense={() => setLicenseOpen(true)} />
      <FlowBar />
      <main className="content" id="content">
        <SubTabs />
        {state.project && SAMPLE[state.screen] ? (
          <p className="sample-note" role="note">
            <strong>Sample data.</strong> {SAMPLE[state.screen]}
          </p>
        ) : null}
        {state.project && PARTLY[state.screen] ? (
          <p className="sample-note" role="note">
            <strong>Partly built.</strong> {PARTLY[state.screen]}
          </p>
        ) : null}
        <Screen />
      </main>
      <FilesPanel />
      {licenseOpen ? <LicenseDialog onClose={() => setLicenseOpen(false)} /> : null}
    </div>
  );
}
