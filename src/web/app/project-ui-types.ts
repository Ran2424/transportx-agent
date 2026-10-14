import type { ComponentType, ReactNode } from 'react';

export type ProjectUi = {
  windowControls: ReactNode;
  softwareUpdate: ReactNode;
  UpdateNotice: ComponentType<{ onOpen(): void }>;
  moduleOptionsCollapsed: boolean;
  nativeActions: boolean;
  onUnauthorized?(): void;
};
