import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { STATUS_WORD } from '../model/status';
import type { Status, StepId } from '../model/types';

/**
 * The few building blocks every screen shares. Colours come from theme.css
 * variables only; a component picks one with a `--tone`.
 */

export const stepVar = (step: StepId) => `var(--st-${step})`;
export const statusVar = (status: Status) => `var(--s-${status})`;
export const tone = (color: string, onColor?: string): CSSProperties =>
  ({ ['--tone' as string]: color, ...(onColor ? { ['--on-tone' as string]: onColor } : {}) }) as CSSProperties;
/** A filled step-coloured surface (primary button, active pill). */
export const stepTone = (step: StepId) => tone(stepVar(step), 'var(--on-step)');

/** A status: always a dot and a word, never colour alone. */
export function StatusText({ status, word }: { status: Status; word?: string }) {
  return (
    <span className="status" style={tone(statusVar(status))}>
      <span className="dot" />
      {word ?? STATUS_WORD[status]}
    </span>
  );
}

export function Pill({ status, children, title }: { status: Status; children: ReactNode; title?: string }) {
  return (
    <span className="pill" style={tone(statusVar(status))} title={title}>
      <span className="dot" />
      {children}
    </span>
  );
}

export function Chip({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span className="chip" style={tone(color)}>
      {children}
    </span>
  );
}

export function ProgressBar({ pct, color, label }: { pct: number; color: string; label?: string }) {
  return (
    <div className="bar" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <span style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: color }} />
    </div>
  );
}

/** Eyebrow, title, one sentence; actions on the right. */
export function ScreenHeader({
  step,
  eyebrow,
  title,
  description,
  actions,
}: {
  step?: StepId;
  eyebrow: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="screen-head">
      <div>
        <div className="eyebrow" style={tone(step ? stepVar(step) : 'var(--text)')}>
          {eyebrow}
        </div>
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="row">{actions}</div> : null}
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  color,
  label,
}: {
  value: T;
  options: readonly T[] | readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  color?: string;
  label: string;
}) {
  return (
    <div className="seg" role="group" aria-label={label} style={color ? tone(color, 'var(--on-step)') : undefined}>
      {options.map((option) => {
        const item = typeof option === 'string' ? { value: option as T, label: option as string } : (option as { value: T; label: string });
        return (
          <button key={item.value} type="button" aria-pressed={item.value === value} onClick={() => onChange(item.value)}>
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

/** A square checkbox drawn to the handoff's look, but a real checkbox for keyboard and screen readers. */
export function Check({ checked, onChange, label, disabled }: { checked: boolean; onChange: () => void; label: string; disabled?: boolean }) {
  return (
    <input
      type="checkbox"
      className="check"
      checked={checked}
      onChange={onChange}
      aria-label={label}
      disabled={disabled}
      onClick={(event) => event.stopPropagation()}
    />
  );
}

/** A placeholder frame until decoded frames and proxies arrive from the media engine. */
export function Frame({ label, style }: { label?: string; style?: CSSProperties }) {
  return (
    <div className="frame-placeholder" style={style}>
      {label ? <span>{label}</span> : null}
    </div>
  );
}

// ---------------------------------------------------------------- the license

export const DEV_ACCESS: Access = {
  plan: 'dit',
  state: 'not-configured',
  email: null,
  serial: null,
  paidThrough: null,
  validUntil: null,
  message: null,
};

export const useAccess = (): Access => {
  const host = typeof window !== 'undefined' ? window.vcdit?.license : undefined;
  const [access, setAccess] = useState<Access>(() => host?.now() ?? DEV_ACCESS);
  useEffect(() => host?.onChange(setAccess), [host]);
  return access;
};

export const NOT_LICENSED = 'Activate VC DIT to start new transfers. Anything already running finishes.';

/**
 * A button that starts work on media (ingest, dailies, delivery). Without a
 * license it stays visible but disabled, and says why (spec: never interrupt
 * a running copy; licensing only gates starting new ones).
 */
export function StartButton({
  children,
  onClick,
  disabledReason,
  step,
  big,
}: {
  children: ReactNode;
  onClick: () => void;
  disabledReason?: string | null;
  step?: StepId;
  big?: boolean;
}) {
  const access = useAccess();
  const reason = access.plan === 'none' ? NOT_LICENSED : disabledReason ?? null;
  return (
    <div className="stack" style={{ gap: 6 }}>
      <button
        type="button"
        className={`btn primary${big ? ' big' : ''}`}
        style={step ? stepTone(step) : undefined}
        disabled={Boolean(reason)}
        title={reason ?? undefined}
        onClick={onClick}
      >
        {children}
      </button>
      {reason ? <span className="why-disabled">{reason}</span> : null}
    </div>
  );
}
