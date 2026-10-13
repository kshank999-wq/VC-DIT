import { describe, expect, it } from 'vitest';
import { jobState, overall, summarize, todos } from '../model/status';
import { initialState, reducer, type AppState } from '../state/store';

const run = (state: AppState, ticks: number) => Array.from({ length: ticks }).reduce<AppState>((s) => reducer(s, { type: 'tick' }), state);

describe('the day, as the app reports it', () => {
  it('starts with one failed card: a problem, and nothing green about Verify', () => {
    const state = initialState();
    expect(jobState(state.jobs[0]!)).toBe('problem');
    expect(summarize(state).verify).toMatchObject({ status: 'problem', metric: '2/5 verified' });
    expect(overall(state)).toMatchObject({ status: 'problem', screen: 'verify' });
    expect(todos(state)[0]).toMatchObject({ status: 'problem', retry: { job: 'A013', leg: 'SHTL_06' } });
  });

  it('a card is safe to format only once every destination verified', () => {
    let state = reducer(initialState(), { type: 'retryLeg', job: 'A013', leg: 'SHTL_06' });
    expect(jobState(state.jobs[0]!)).toBe('running');
    state = run(state, 200);
    expect(state.jobs.every((job) => jobState(job) === 'safe')).toBe(true);
    expect(summarize(state).verify.status).toBe('done');
  });

  it('starts the queued card only when nothing else is copying', () => {
    let state = initialState();
    expect(state.jobs.find((job) => job.id === 'A015')?.queued).toBe(true);
    state = run(state, 200);
    expect(state.jobs.find((job) => job.id === 'A015')).toMatchObject({ queued: false });
    expect(jobState(state.jobs.find((job) => job.id === 'A015')!)).toBe('safe');
  });

  it('never lets a card be a destination', () => {
    let state = reducer(initialState(), { type: 'setVolumeRole', volume: 'SHTL08', role: 'Camera' });
    state = reducer(state, { type: 'toggleDestination', destination: 'SHTL08' });
    expect(state.volumes.find((volume) => volume.id === 'SHTL08')).toMatchObject({ role: 'Camera', included: false });
  });

  it('ingest queues the included cards to every selected destination and goes to Verify', () => {
    const state = reducer(initialState(), { type: 'startIngest' });
    expect(state.screen).toBe('verify');
    const b010 = state.jobs.find((job) => job.id === 'B010');
    expect(b010?.legs.map((leg) => leg.name)).toEqual(['HLC_RAID_01', 'SHTL_07', 'PROD_NAS']);
    expect(summarize(state).intake.status).toBe('done');
  });

  it('match decisions move to the next open one, and a confirmed match unblocks its VFX shot', () => {
    let state = initialState();
    state = reducer(state, { type: 'selectMatch', id: 'm1' });
    state = reducer(state, { type: 'confirmMatch', id: 'm1' });
    expect(state.selectedMatch).toBe('m0');
    expect(state.vfx.find((shot) => shot.clip === 'B010C004')?.prep).toBe('eligible');
    state = reducer(reducer(state, { type: 'markWild', id: 'm0' }), { type: 'confirmMatch', id: 'm2' });
    expect(summarize(state).organize).toMatchObject({ status: 'done', metric: '64/64 matched' });
  });

  it('is all good once everything is handled', () => {
    let state = reducer(initialState(), { type: 'retryLeg', job: 'A013', leg: 'SHTL_06' });
    state = reducer(state, { type: 'startIngest' });
    state = run(state, 400);
    for (const id of ['m0', 'm1', 'm2']) state = reducer(state, { type: 'confirmMatch', id });
    state = state.sync.reduce((s, _item, index) => reducer(reducer(s, { type: 'selectSync', index }), { type: 'acceptSync' }), state);
    expect(overall(state)).toMatchObject({ status: 'done', label: 'All good' });
  });
});
