import type { ModuleLocalizedPresentation, ModulePresentation } from '../../contracts/module';
import { LEGACY_MODULE_PRESENTATIONS } from './legacy-module-presentation.ts';

export type PresentableModule = { id?: string; name: string; presentation?: ModulePresentation };

export function moduleDisplayMetadata(module: PresentableModule) {
  return module.presentation ?? (module.id && Object.hasOwn(LEGACY_MODULE_PRESENTATIONS, module.id) ? LEGACY_MODULE_PRESENTATIONS[module.id] : undefined);
}

function selectText(presentation: ModuleLocalizedPresentation | undefined, language: string) {
  if (!presentation) return undefined;
  const locale = language.toLowerCase().startsWith('zh') ? 'zh-CN' : language.toLowerCase().startsWith('en') ? 'en-US' : presentation.defaultLocale;
  return presentation.locales[locale] ?? presentation.locales[presentation.defaultLocale];
}

export function modulePresentation(module: PresentableModule, language: string, target?: { skillPath?: string; assetId?: string }) {
  const presentation = moduleDisplayMetadata(module);
  const specific = target?.assetId ? presentation?.assets?.[target.assetId] : target?.skillPath ? presentation?.skills?.[target.skillPath] : undefined;
  const text = selectText(specific, language) ?? selectText(presentation, language);
  return { name: text?.name ?? module.name, description: text?.description ?? '', features: text?.features ?? [] };
}

/** Search all provided languages without changing the displayed language. */
export function moduleSearchText(module: PresentableModule) {
  const presentation = moduleDisplayMetadata(module);
  return [module.name, ...[presentation, ...Object.values(presentation?.skills ?? {}), ...Object.values(presentation?.assets ?? {})]
    .flatMap((entry) => Object.values(entry?.locales ?? {}).flatMap((text) => text ? [text.name, text.description, ...(text.features ?? [])] : []))].join(' ');
}
