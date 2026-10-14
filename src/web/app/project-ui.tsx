import { WindowControls } from '../components/shell/WindowControls';
import { SoftwareUpdate, SoftwareUpdateNotice } from '../platform/settings/SoftwareUpdate';
import type { ProjectUi } from './project-ui-types';

export const projectUi: ProjectUi = {
  windowControls: <WindowControls />,
  softwareUpdate: <SoftwareUpdate />,
  UpdateNotice: SoftwareUpdateNotice,
  moduleOptionsCollapsed: false,
  nativeActions: true,
};
