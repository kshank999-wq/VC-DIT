import type { ComponentType } from 'react';
import type { ScreenId } from '../model/types';
import { Dailies } from './Dailies';
import { Delivery } from './Delivery';
import { Intake } from './Intake';
import { Looks } from './Looks';
import { MatchReview } from './MatchReview';
import { ProjectSetup } from './ProjectSetup';
import { Reports } from './Reports';
import { SceneOrganizer } from './SceneOrganizer';
import { SyncWorkspace } from './SyncWorkspace';
import { Today } from './Today';
import { Verify } from './Verify';
import { VfxHandoff } from './VfxHandoff';

/** Every screen, by id. */
export const SCREENS: Record<ScreenId, ComponentType> = {
  today: Today,
  setup: ProjectSetup,
  intake: Intake,
  verify: Verify,
  scenes: SceneOrganizer,
  match: MatchReview,
  vfx: VfxHandoff,
  sync: SyncWorkspace,
  looks: Looks,
  dailies: Dailies,
  delivery: Delivery,
  reports: Reports,
};
