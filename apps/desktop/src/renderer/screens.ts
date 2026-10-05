/**
 * The screens of the development spec (docs/SPEC_v1.md §7), in workflow order.
 * Each is a placeholder until the UI mockup lands; the list is what the
 * navigation is built from, so adding a screen is one entry here.
 */
export interface Screen {
  id: string;
  name: string;
  /** What the spec says the screen is for. */
  purpose: string;
}

export const SCREENS: Screen[] = [
  {
    id: 'dashboard',
    name: 'Production Dashboard',
    purpose: 'Current shoot day, cards waiting, active transfers, verification health, scenes shot, sync status, VFX count, delivery status.',
  },
  { id: 'intake', name: 'Media Intake', purpose: 'Detected sources on the left, destination targets on the right; start a verified ingest.' },
  { id: 'transfers', name: 'Transfer Monitor', purpose: 'Card-by-card and destination-by-destination copy and verify status.' },
  { id: 'scenes', name: 'Scene Organizer', purpose: 'Scenes and setups for the day, with matched and unmatched clips and script supervisor data.' },
  { id: 'sync', name: 'Sync Workspace', purpose: 'Batch timecode and waveform sync, with exception review.' },
  { id: 'looks', name: 'LUT / Look Manager', purpose: 'Production LUT library, assignment rules, preview and dailies application.' },
  { id: 'dailies', name: 'Dailies Builder', purpose: 'Selects, synced media, metadata, look, codec and resolution presets, Frame.io publish target.' },
  { id: 'vfx', name: 'VFX Handoff', purpose: 'VFX-designated assets by scene and setup, notes, prep eligibility, send to VC VFX Prep.' },
  { id: 'delivery', name: 'Delivery Manager', purpose: 'Packages, multiple destinations, verification and the final manifest.' },
];
