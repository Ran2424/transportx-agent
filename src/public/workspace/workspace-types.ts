export type WorkspaceView = {
  id: string;
  panel: HTMLElement;
  sidebarClass?: string;
  activate(): void | Promise<void>;
  resize?(): void;
};

export interface WorkspaceRegistration {
  registerView(view: WorkspaceView): void;
}
