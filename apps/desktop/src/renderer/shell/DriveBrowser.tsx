import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatBytes, type BrowseEntry, type BrowseRoot } from '../../shared/media';
import { legState } from '../model/status';
import type { StepId, TransferLeg } from '../model/types';
import { engine } from '../state/engine';
import { useStore } from '../state/store';
import { statusVar, stepVar, tone } from '../ui/kit';

/**
 * The Files panel on the drives: what is really in the production's folder
 * on a destination (the RAID, a shuttle, a NAS folder), read a folder at a
 * time as it is opened and read again every few seconds while it is open,
 * so a card being copied fills in as it goes. Read-only: a file can be
 * shown in Finder or Explorer, or opened with its app; nothing is moved,
 * renamed or deleted from here.
 */

const STEP_OF: [RegExp, StepId][] = [
  [/^(CAMERA|SOUND)_ORIGINALS$/, 'intake'],
  [/^(_BY_SCENE|SCENE_.*|SETUP_.*|SELECTS_CIRCLE_TAKES)$/, 'organize'],
  [/^VFX$/, 'vfx'],
  [/^SYNCED_DAILIES$/, 'sync'],
  [/^(LUTS_LOOKS|DELIVERED|REPORTS)$/, 'output'],
];
const colorOf = (entry: BrowseEntry): string => {
  if (entry.kind !== 'folder') return 'var(--faint)';
  const step = STEP_OF.find(([pattern]) => pattern.test(entry.name))?.[1];
  return step ? stepVar(step) : 'var(--text)';
};

const ROOT_KEY = 'vcdit.files.root';
const remembered = () => {
  try {
    return localStorage.getItem(ROOT_KEY);
  } catch {
    return null;
  }
};
const remember = (id: string) => {
  try {
    localStorage.setItem(ROOT_KEY, id);
  } catch {
    // Private storage unavailable: the choice lasts this session.
  }
};

/** Paths compared as the drives do: separators alike, no trailing slash, case-insensitive. */
const norm = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

const REFRESH_MS = 4000;

type Listing = { entries: BrowseEntry[]; more: number } | { error: string };

export function DriveBrowser({ query }: { query: string }) {
  const { state } = useStore();
  const media = engine();
  const production = state.production.name || state.production.code;
  const [roots, setRoots] = useState<BrowseRoot[] | null>(null);
  const [rootId, setRootId] = useState<string | null>(remembered());
  const [listings, setListings] = useState<Record<string, Listing>>({});
  const [open, setOpen] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [hits, setHits] = useState<{ entries: BrowseEntry[]; complete: boolean } | { error: string } | null>(null);
  const windows = typeof window !== 'undefined' && window.vcdit?.platform === 'win32';
  const live = useRef(true);
  useEffect(() => () => void (live.current = false), []);

  // The drives to choose from, again whenever what is plugged in changes.
  const plugged = [...state.volumes.map((volume) => `${volume.id}:${volume.role}`), ...state.destinations.map((folder) => folder.id)].join('|');
  useEffect(() => {
    if (!media?.browseRoots) return;
    void media.browseRoots(production).then((found) => {
      if (!live.current) return;
      setRoots(found);
      setRootId((current) => (current && found.some((root) => root.id === current) ? current : (found.find((root) => root.present)?.id ?? found[0]?.id ?? null)));
    });
  }, [plugged, production]); // eslint-disable-line react-hooks/exhaustive-deps

  const root = roots?.find((candidate) => candidate.id === rootId) ?? null;

  const load = useCallback(
    async (rel: string) => {
      if (!media?.browse || !rootId) return;
      const listing = await media.browse(rootId, production, rel);
      if (!live.current) return;
      setListings((before) => ({ ...before, [rel]: listing.ok ? { entries: listing.entries, more: listing.more } : { error: listing.reason } }));
    },
    [media, rootId, production],
  );

  // A different drive: start from its production folder, closed.
  useEffect(() => {
    setListings({});
    setOpen([]);
    setSelected(null);
    void load('');
  }, [load]);

  // Read the open folders again every few seconds, so copies show as they land.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.hidden) return;
      for (const rel of ['', ...open]) void load(rel);
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load, open]);

  // Searching looks through the whole production folder on this drive.
  useEffect(() => {
    if (!query || !media?.browseSearch || !rootId) {
      setHits(null);
      return undefined;
    }
    const timer = setTimeout(() => {
      void media.browseSearch(rootId, production, query).then((found) => {
        if (live.current) setHits(found.ok ? { entries: found.entries, complete: found.complete } : { error: found.reason });
      });
    }, 250);
    return () => clearTimeout(timer);
  }, [query, rootId, production]); // eslint-disable-line react-hooks/exhaustive-deps

  // A card folder being copied or checked carries its state, as in Verify.
  const legsByDir = useMemo(() => {
    const map = new Map<string, TransferLeg>();
    for (const job of state.jobs) for (const leg of job.legs) if (leg.targetDir) map.set(norm(leg.targetDir), leg);
    return map;
  }, [state.jobs]);

  const toggle = (rel: string) => {
    if (open.includes(rel)) setOpen(open.filter((item) => item !== rel && !item.startsWith(`${rel}/`)));
    else {
      setOpen([...open, rel]);
      if (!listings[rel]) void load(rel);
    }
  };
  const reveal = (entry: BrowseEntry, openIt = false) => rootId && void media?.reveal(rootId, production, entry.rel, openIt);

  if (!media?.browse) return null;
  if (roots && roots.length === 0) {
    return (
      <p className="files-note muted">
        No destination yet. Give a drive the Destination, Shuttle or Archive role in Intake, or add a destination folder, and its {production} folder shows here.
      </p>
    );
  }

  const row = (entry: BrowseEntry, depth: number, flat = false) => {
    const isOpen = open.includes(entry.rel);
    const leg = entry.kind === 'folder' ? legsByDir.get(norm(entry.path)) : undefined;
    const legNow = leg ? legState(leg) : null;
    const status = legNow === 'verified' ? 'done' : legNow === 'failed' ? 'problem' : legNow === 'waiting' || legNow === null ? null : 'working';
    const listing = listings[entry.rel];
    return (
      <div key={`${flat ? 'hit:' : ''}${entry.rel}`}>
        <div
          role="treeitem"
          aria-expanded={entry.kind === 'folder' && !flat ? isOpen : undefined}
          aria-selected={selected === entry.rel}
          tabIndex={0}
          className={`tree-row drive-row${selected === entry.rel ? ' selected' : ''}`}
          style={{ paddingLeft: 10 + depth * 14 }}
          title={entry.rel}
          onClick={() => {
            setSelected(entry.rel);
            if (entry.kind === 'folder' && !flat) toggle(entry.rel);
          }}
          onDoubleClick={() => (entry.kind === 'file' ? reveal(entry, true) : flat ? reveal(entry) : undefined)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              event.currentTarget.click();
            }
          }}
        >
          <span className="caret" aria-hidden="true">
            {entry.kind === 'folder' && !flat ? (isOpen ? '▾' : '▸') : ''}
          </span>
          {entry.kind === 'folder' ? <span className="folder" style={{ background: colorOf(entry) }} aria-hidden="true" /> : <span className="file-glyph" aria-hidden="true" />}
          <span className={`mono tree-name${entry.kind === 'folder' && depth <= 1 ? ' strong' : ''}`}>{flat ? entry.rel : entry.name}</span>
          {entry.linked ? (
            <span className="linked" title={entry.kind === 'link' ? 'A link to somewhere else' : 'Same data as another name on this drive (a scene view or VFX mirror): no extra space'}>
              ↗
            </span>
          ) : null}
          <span className="grow" />
          <span className="mono tree-count">
            {entry.kind === 'folder' ? (entry.items ?? '') : entry.kind === 'file' ? `${entry.sequence ? `${entry.sequence.frames.toLocaleString('en-US')} frames · ` : ''}${formatBytes(entry.size)}` : ''}
          </span>
          {status ? <span className="dot" style={tone(statusVar(status))} title={leg ? `${leg.name}: ${legNow}` : undefined} /> : null}
          <button
            type="button"
            className="tree-reveal"
            aria-label={`Show ${entry.name} in ${windows ? 'Explorer' : 'Finder'}`}
            title={windows ? 'Show in Explorer' : 'Show in Finder'}
            onClick={(event) => {
              event.stopPropagation();
              reveal(entry);
            }}
          >
            ⌕
          </button>
        </div>
        {isOpen && !flat && listing
          ? 'error' in listing
            ? <div className="files-note faint" style={{ paddingLeft: 24 + depth * 14 }}>{listing.error}</div>
            : (
                <>
                  {listing.entries.length === 0 ? <div className="files-note faint" style={{ paddingLeft: 24 + (depth + 1) * 14 }}>Empty</div> : null}
                  {listing.entries.map((child) => row(child, depth + 1))}
                  {listing.more ? <div className="files-note faint" style={{ paddingLeft: 24 + (depth + 1) * 14 }}>…and {listing.more} more</div> : null}
                </>
              )
          : null}
      </div>
    );
  };

  const top = listings[''];
  return (
    <div className="drive-browser">
      <div className="drive-pick row">
        <select className="select" aria-label="Drive to browse" value={rootId ?? ''} onChange={(event) => { setRootId(event.target.value); remember(event.target.value); }}>
          {(roots ?? []).map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
              {candidate.present ? '' : ' (nothing here yet)'}
            </option>
          ))}
        </select>
        <button type="button" className="btn ghost small" title="Read the open folders again" onClick={() => ['', ...open].forEach((rel) => void load(rel))}>
          Refresh
        </button>
      </div>
      <div className="tree" role="tree" aria-label={root ? `${production} on ${root.name}` : 'Drive'}>
        {query ? (
          hits === null ? (
            <div className="files-note faint">Searching…</div>
          ) : 'error' in hits ? (
            <div className="files-note faint">{hits.error}</div>
          ) : (
            <>
              {hits.entries.length === 0 ? <div className="files-note faint">Nothing called “{query}” on {root?.name}.</div> : null}
              {hits.entries.map((entry) => row(entry, 0, true))}
              {!hits.complete ? <div className="files-note faint">Showing the first {hits.entries.length}. Type more to narrow it.</div> : null}
            </>
          )
        ) : top ? (
          'error' in top ? (
            <div className="files-note muted">
              {root ? `No ${production} folder on ${root.name} yet. It appears with the first card copied there.` : top.error}
            </div>
          ) : (
            <>
              <div className="tree-row drive-root" style={{ paddingLeft: 10 }}>
                <span className="caret" aria-hidden="true">▾</span>
                <span className="folder" style={{ background: 'var(--text)' }} aria-hidden="true" />
                <span className="mono tree-name strong">{production}</span>
              </div>
              {top.entries.length === 0 ? <div className="files-note faint">Empty</div> : null}
              {top.entries.map((entry) => row(entry, 1))}
            </>
          )
        ) : (
          <div className="files-note faint">Reading {root?.name ?? 'the drive'}…</div>
        )}
      </div>
    </div>
  );
}
