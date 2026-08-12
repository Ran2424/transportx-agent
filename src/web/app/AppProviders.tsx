import { createContext, useContext, type ReactNode } from 'react';
import type { AppKernel } from '../../public/kernel/app-kernel.js';
import { appKernel, reconnectBrowserApplication } from './composition-root';
import { LocaleProvider } from '../i18n/LocaleProvider';

type AppServices = {
  kernel: AppKernel;
  reconnect(): void;
};

const services: AppServices = {
  kernel: appKernel,
  reconnect: reconnectBrowserApplication,
};

const AppServicesContext = createContext<AppServices | null>(null);

export function AppProviders({ children }: { children: ReactNode }) {
  return <LocaleProvider><AppServicesContext.Provider value={services}>{children}</AppServicesContext.Provider></LocaleProvider>;
}

export function useAppServices(): AppServices {
  const value = useContext(AppServicesContext);
  if (!value) throw new Error('AppProviders is missing');
  return value;
}
