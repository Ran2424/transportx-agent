import { createContext, useContext } from 'react';
import type { DocumentRequest } from './document-state';

export const OpenDocumentContext = createContext<(request: DocumentRequest) => void>(() => { throw new Error('Document opener is unavailable'); });
export function useOpenDocument() { return useContext(OpenDocumentContext); }
