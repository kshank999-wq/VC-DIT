import { useEffect, useState } from 'react';
import type { FrameioTarget, ProjectResult } from '../../shared/project';
import { projectApi } from '../state/engine';
import { useStore } from '../state/store';
import { StartButton, StatusText, statusVar, tone } from './kit';

/**
 * Frame.io on the Dailies screen: sign in (in the browser, through Adobe),
 * choose the production's project, and publish the day's rendered dailies
 * to it, into Dailies / Day / Sc. What is published, and what is not yet,
 * shows on each daily in Rendered today.
 */

type Item = { id: string; name: string; rootFolderId?: string; viewUrl?: string | null };

export function FrameioPublish() {
  const { state, dispatch } = useStore();
  const api = projectApi();
  const { frameio } = state;
  const [notice, setNotice] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [accounts, setAccounts] = useState<Item[] | null>(null);
  const [workspaces, setWorkspaces] = useState<Item[] | null>(null);
  const [projects, setProjects] = useState<Item[] | null>(null);
  const [account, setAccount] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [project, setProject] = useState('');

  const act = (call: Promise<ProjectResult>) =>
    call.then((result) => {
      if (result.ok) {
        setNotice(null);
        dispatch({ type: 'projectState', project: result.state });
      } else if (result.reason) setNotice(result.reason);
      return result.ok;
    });

  const picking = choosing || (frameio.user !== null && frameio.target === null);

  // The picker, a level at a time.
  useEffect(() => {
    if (!api || !picking || !frameio.user) return;
    let live = true;
    void api.browseFrameio(null, null).then((result) => {
      if (!live) return;
      if (result.ok) {
        setAccounts(result.items);
        if (result.items.length === 1) setAccount(result.items[0]!.id);
      } else setNotice(result.reason);
    });
    return () => {
      live = false;
    };
  }, [api, picking, frameio.user]);
  useEffect(() => {
    setWorkspaces(null);
    setWorkspace('');
    if (!api || !account) return;
    let live = true;
    void api.browseFrameio(account, null).then((result) => {
      if (!live) return;
      if (result.ok) {
        setWorkspaces(result.items);
        if (result.items.length === 1) setWorkspace(result.items[0]!.id);
      } else setNotice(result.reason);
    });
    return () => {
      live = false;
    };
  }, [api, account]);
  useEffect(() => {
    setProjects(null);
    setProject('');
    if (!api || !account || !workspace) return;
    let live = true;
    void api.browseFrameio(account, workspace).then((result) => {
      if (!live) return;
      if (result.ok) setProjects(result.items);
      else setNotice(result.reason);
    });
    return () => {
      live = false;
    };
  }, [api, account, workspace]);

  if (!api) return null;

  const connect = () => {
    setSigningIn(true);
    setNotice(null);
    void act(api.connectFrameio()).finally(() => setSigningIn(false));
  };

  const choose = () => {
    const a = accounts?.find((item) => item.id === account);
    const w = workspaces?.find((item) => item.id === workspace);
    const p = projects?.find((item) => item.id === project);
    if (!a || !w || !p?.rootFolderId) return;
    const target: FrameioTarget = {
      accountId: a.id,
      accountName: a.name,
      workspaceId: w.id,
      workspaceName: w.name,
      projectId: p.id,
      projectName: p.name,
      rootFolderId: p.rootFolderId,
      viewUrl: p.viewUrl ?? null,
    };
    void act(api.setFrameioTarget(target)).then((ok) => {
      if (ok) setChoosing(false);
    });
  };

  const pending = state.renders.filter((render) => render.state === 'done' && render.frameio?.state !== 'done').length;
  const onFrameio = state.renders.filter((render) => render.frameio?.state === 'done').length;
  const publishReason = state.dailiesActivity
    ? 'Dailies are rendering. Publish when they have finished.'
    : pending === 0
      ? state.renders.some((render) => render.state === 'done')
        ? 'Every rendered daily of the day is on Frame.io.'
        : 'Build dailies first.'
      : undefined;

  return (
    <section className="card">
      <div className="card-head">
        <h3>Frame.io</h3>
        <span className="small">
          {!frameio.available ? (
            <StatusText status="idle" word="Not in this build" />
          ) : frameio.user ? (
            <StatusText status="done" word="Connected" />
          ) : (
            <StatusText status="idle" word="Not connected" />
          )}
        </span>
      </div>
      <div className="card-body stack fio-body">
        {notice ? (
          <p className="dailies-notice fio-notice" role="alert" style={tone(statusVar('problem'))}>
            {notice}
          </p>
        ) : null}

        {!frameio.available ? (
          <p className="muted small">This build of VC DIT is not set up to sign in to Frame.io. A release build carries the Adobe sign-in for it.</p>
        ) : !frameio.user ? (
          <>
            <p className="muted small">Sign in with your Adobe ID in the browser. VC DIT keeps the sign-in on this computer only, never in the production file.</p>
            {signingIn ? (
              <div className="row">
                <StatusText status="working" word="Finish signing in in your browser…" />
                <button type="button" className="btn" onClick={() => void api.cancelFrameio()}>
                  Cancel
                </button>
              </div>
            ) : (
              <button type="button" className="btn primary" onClick={connect}>
                Connect Frame.io…
              </button>
            )}
          </>
        ) : picking ? (
          <>
            <p className="muted small">Signed in as {frameio.user}. Choose the project this production publishes its dailies to.</p>
            <label className="fio-field">
              <span className="label">Account</span>
              <select className="select" aria-label="Frame.io account" value={account} onChange={(event) => setAccount(event.target.value)} disabled={!accounts}>
                <option value="">{accounts ? 'Choose…' : 'Loading…'}</option>
                {accounts?.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="fio-field">
              <span className="label">Workspace</span>
              <select className="select" aria-label="Frame.io workspace" value={workspace} onChange={(event) => setWorkspace(event.target.value)} disabled={!workspaces}>
                <option value="">{account ? (workspaces ? 'Choose…' : 'Loading…') : '—'}</option>
                {workspaces?.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="fio-field">
              <span className="label">Project</span>
              <select className="select" aria-label="Frame.io project" value={project} onChange={(event) => setProject(event.target.value)} disabled={!projects}>
                <option value="">{workspace ? (projects ? (projects.length ? 'Choose…' : 'No projects in this workspace') : 'Loading…') : '—'}</option>
                {projects?.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="row gap-8">
              <button type="button" className="btn primary" disabled={!project} onClick={choose}>
                Publish here
              </button>
              {frameio.target ? (
                <button type="button" className="btn ghost" onClick={() => setChoosing(false)}>
                  Cancel
                </button>
              ) : null}
            </div>
          </>
        ) : frameio.target ? (
          <>
            <div className="stack gap-3">
              <span className="strong-500">{frameio.target.projectName}</span>
              <span className="muted small">
                {frameio.target.accountName} · {frameio.target.workspaceName} · into Dailies / Day {String(state.day.number).padStart(3, '0')} / Sc
              </span>
            </div>
            <div className="row gap-8 wrap">
              {frameio.target.viewUrl ? (
                <button type="button" className="btn ghost small" onClick={() => void api.openFrameio(frameio.target!.viewUrl!)}>
                  Open in Frame.io ↗
                </button>
              ) : null}
              <button type="button" className="btn ghost small" disabled={frameio.activity !== null} onClick={() => setChoosing(true)}>
                Change project
              </button>
            </div>
            {frameio.problem ? (
              <p className="dailies-notice fio-notice" role="status" style={tone(statusVar('needs'))}>
                {frameio.problem}
              </p>
            ) : null}
            <div className="row summary-row">
              <span className="grow muted small">
                {onFrameio} on Frame.io · {pending} to publish
              </span>
              {frameio.activity ? (
                <div className="row">
                  <StatusText status="working" word={frameio.activity} />
                  <button type="button" className="btn" onClick={() => void act(api.stopFrameio())}>
                    Stop
                  </button>
                </div>
              ) : (
                <StartButton disabledReason={publishReason} onClick={() => void act(api.publishFrameio())}>
                  {`Publish ${pending || ''} to Frame.io`.replace('  ', ' ')}
                </StartButton>
              )}
            </div>
          </>
        ) : null}

        {frameio.available && frameio.user ? (
          <p className="muted small fio-note">
            Signed in as {frameio.user}.{' '}
            <button type="button" className="btn ghost small" disabled={frameio.activity !== null} onClick={() => void act(api.disconnectFrameio())}>
              Sign out
            </button>
          </p>
        ) : null}
      </div>
    </section>
  );
}
