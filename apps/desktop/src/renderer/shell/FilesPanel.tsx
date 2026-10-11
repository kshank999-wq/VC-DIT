import { useState } from 'react';
import { jobState, STEPS, summarize } from '../model/status';
import type { ScreenId, Status, StepId } from '../model/types';
import { useStore, type Action, type AppState } from '../state/store';
import { stepVar, statusVar, tone } from '../ui/kit';

/**
 * The production's folders, numbered to mirror the flow (handoff "Files
 * Panel"). ↗ folders are views in the media index or hard links, never extra
 * physical copies (spec §5, §4.9). In the desktop app the folders carry
 * their real names on the drives and the counts come from the production.
 */

interface Node {
  path: string;
  name: string;
  color: string;
  count?: string;
  status?: Status;
  linked?: boolean;
  /** Where clicking goes (besides opening the folder). */
  action?: Action;
  children?: Node[];
}

const pad3 = (id: string) => id.replace(/^(\d+)/, (digits) => digits.padStart(3, '0'));

/** The REPORTS folder's own subfolders on the drives. */
const REAL_REPORTS: [string, StepId, ScreenId][] = [
  ['ingest_verification', 'verify', 'verify'],
  ['vfx_mirror', 'vfx', 'vfx'],
  ['dailies', 'output', 'dailies'],
  ['delivery', 'output', 'delivery'],
  ['day_report', 'output', 'reports'],
];

export const buildTree = (state: AppState): Node[] => {
  const steps = summarize(state);
  const go = (screen: ScreenId): Action => ({ type: 'go', screen });
  const color = (step: StepId) => stepVar(step);
  const shot = state.scenes.filter((scene) => scene.setups.length > 0);
  const vfxScenes = [...new Set(state.vfx.map((item) => `${item.scene}|${item.setup}`))];
  const failed = state.jobs.some((job) => jobState(job) === 'problem');
  const reports: [string, StepId, ScreenId][] = [
    ['ingest_verification', 'verify', 'verify'],
    ['script_supervisor', 'organize', 'match'],
    ['sync', 'sync', 'sync'],
    ['delivery_manifests', 'output', 'delivery'],
  ];
  const takes = (n: number) => String(n);
  const media = state.project ? state.media : null;
  /** The demo numbers the folders to follow the flow; on the drives they have their own names. */
  const label = (numbered: string, plain: string) => (media ? plain : numbered);
  const count = (n: number) => n.toLocaleString('en-US');
  const done = state.renders.filter((render) => render.state === 'done').length;
  const records = state.delivery?.records ?? [];
  const deliveredTo = [...new Set(records.map((record) => record.destination))];

  return [
    {
      path: 'root',
      name: state.production.name,
      color: 'var(--text)',
      children: [
        {
          path: 'day',
          name: `SHOOT_DAY_${String(state.day.number).padStart(3, '0')}`,
          color: 'var(--text)',
          count: new Date(`${state.day.date}T12:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }),
          children: [
            {
              path: 'ocf',
              name: label('01_CAMERA_ORIGINALS', 'CAMERA_ORIGINALS'),
              color: color('intake'),
              count: media ? count(media.cameraFiles) : '1,596',
              // A failed check shows here too: nothing is green while a copy failed.
              status: failed ? 'problem' : steps.verify.status === 'done' ? 'done' : undefined,
              action: go('verify'),
              children: shot.map((scene) => ({
                path: `ocf/${scene.id}`,
                name: `SCENE_${pad3(scene.id)}`,
                color: color('organize'),
                count: takes(scene.setups.reduce((sum, setup) => sum + setup.takes.length, 0)),
                action: { type: 'selectSetup', key: `${scene.id}|${scene.setups[0]!.id}` },
                children: scene.setups.map((setup) => ({
                  path: `ocf/${scene.id}/${setup.id}`,
                  name: `SETUP_${setup.id}`,
                  color: color('organize'),
                  count: takes(setup.takes.length),
                  action: { type: 'selectSetup', key: `${scene.id}|${setup.id}` },
                })),
              })),
            },
            {
              path: 'snd',
              name: label('02_SOUND_ORIGINALS', 'SOUND_ORIGINALS'),
              color: color('intake'),
              count: media ? count(media.soundFiles) : '96',
              status: media && media.soundFiles === 0 ? undefined : failed ? 'problem' : 'done',
              action: go('verify'),
            },
            {
              path: 'sel',
              name: label('03_SELECTS', 'SELECTS_CIRCLE_TAKES'),
              color: color('organize'),
              linked: true,
              count: String(state.scenes.flatMap((scene) => scene.setups.flatMap((setup) => setup.takes)).filter((take) => take.circle).length),
              action: go('scenes'),
            },
            {
              path: 'vfx',
              name: label('04_VFX', 'VFX'),
              color: color('vfx'),
              linked: true,
              count: String(state.vfx.length),
              action: go('vfx'),
              children: vfxScenes.map((key) => {
                const [scene, setup] = key.split('|');
                return { path: `vfx/${key}`, name: `SCENE_${pad3(scene!)}/SETUP_${setup}`, color: color('vfx'), linked: true, action: go('vfx') };
              }),
            },
            media
              ? {
                  path: 'syn',
                  name: 'SYNCED_DAILIES',
                  color: color('sync'),
                  count: count(done),
                  status: state.renders.some((render) => render.state === 'failed') ? 'problem' : done > 0 ? 'done' : undefined,
                  action: go('dailies'),
                }
              : { path: 'syn', name: '05_SYNCED_DAILIES', color: color('sync'), count: steps.sync.metric.split(' ')[0], status: steps.sync.status === 'done' ? 'done' : 'needs', action: go('sync') },
            { path: 'lut', name: label('06_LUTS_LOOKS', 'LUTS_LOOKS'), color: color('output'), count: String(state.luts.length), action: go('looks') },
            media
              ? {
                  // Not a folder of the day: where it went.
                  path: 'del',
                  name: 'DELIVERED',
                  color: color('output'),
                  count: count(records.length),
                  status: records.some((record) => record.failed > 0) ? 'problem' : records.length ? 'done' : undefined,
                  action: go('delivery'),
                  children: deliveredTo.map((name) => ({
                    path: `del/${name}`,
                    name,
                    color: color('output'),
                    count: count(records.filter((record) => record.destination === name).length),
                    status: records.some((record) => record.destination === name && record.failed > 0) ? ('problem' as const) : ('done' as const),
                    action: go('delivery'),
                  })),
                }
              : {
                  path: 'del',
                  name: '07_DELIVERY',
                  color: color('output'),
                  count: steps.output.metric.split(' ')[0],
                  action: go('delivery'),
                  children: ['EDITORIAL_HANDOFF', 'DAILIES_FRAMEIO', 'ARCHIVE'].map((name) => ({ path: `del/${name}`, name, color: color('output'), action: go('delivery') })),
                },
            {
              path: 'rep',
              name: label('08_REPORTS', 'REPORTS'),
              color: 'var(--faint)',
              count: media ? undefined : String(state.jobs.length + 5),
              action: go('reports'),
              children: (media ? REAL_REPORTS : reports).map(([name, step, screen]) => ({ path: `rep/${name}`, name, color: color(step), action: go(screen) })),
            },
          ],
        },
      ],
    },
  ];
};

const matches = (node: Node, query: string): boolean =>
  node.name.toLowerCase().includes(query) || (node.children ?? []).some((child) => matches(child, query));

function TreeRow({ node, depth, query }: { node: Node; depth: number; query: string }) {
  const { state, dispatch } = useStore();
  if (query && !matches(node, query)) return null;
  const hasChildren = Boolean(node.children?.length);
  // Searching opens everything that matches, so a hit is never hidden in a closed folder.
  const open = hasChildren && (query ? true : state.openFolders.includes(node.path));
  const selected = node.action?.type === 'selectSetup' && state.screen === 'scenes' && state.selectedSetup === node.action.key && node.path.split('/').length === 3;
  return (
    <>
      <div
        role="treeitem"
        aria-expanded={hasChildren ? open : undefined}
        aria-selected={selected}
        tabIndex={0}
        className={`tree-row${selected ? ' selected' : ''}`}
        style={{ paddingLeft: 10 + depth * 14 }}
        onClick={() => {
          if (hasChildren) dispatch({ type: 'toggleFolder', path: node.path });
          if (node.action) dispatch(node.action);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            event.currentTarget.click();
          }
        }}
      >
        <span className="caret" aria-hidden="true">
          {hasChildren ? (open ? '▾' : '▸') : ''}
        </span>
        <span className="folder" style={{ background: node.color }} aria-hidden="true" />
        <span className={`mono tree-name${depth <= 1 ? ' strong' : ''}`}>{node.name}</span>
        {node.linked ? (
          <span className="linked" title="Linked folder — same clips, no extra copy">
            ↗
          </span>
        ) : null}
        <span className="grow" />
        {node.count ? <span className="mono tree-count">{node.count}</span> : null}
        {node.status ? <span className="dot" style={tone(statusVar(node.status))} title={node.status} /> : null}
      </div>
      {open ? node.children!.map((child) => <TreeRow key={child.path} node={child} depth={depth + 1} query={query} />) : null}
    </>
  );
}

export function FilesPanel() {
  const { state } = useStore();
  const [query, setQuery] = useState('');
  return (
    <aside className="files" aria-label="Project files">
      <div className="files-head">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <strong>Project files</strong>
          <span className="mono faint" style={{ fontSize: 11 }}>
            {state.project ? (state.media?.home ?? 'No drive yet') : 'RAID_01'}
          </span>
        </div>
        <input className="input" placeholder="Search clips, scenes, takes…" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search project files" />
      </div>
      <div className="tree" role="tree">
        {buildTree(state).map((node) => (
          <TreeRow key={node.path} node={node} depth={0} query={query.trim().toLowerCase()} />
        ))}
      </div>
      <div className="files-foot">
        <div className="legend">
          {STEPS.map((step) => (
            <span key={step.id}>
              <span className="folder" style={{ background: stepVar(step.id) }} />
              {step.name}
            </span>
          ))}
        </div>
        <div className="faint" style={{ fontSize: 11.5 }}>
          ↗ Linked folder — same clips, no extra copy.
        </div>
      </div>
    </aside>
  );
}
