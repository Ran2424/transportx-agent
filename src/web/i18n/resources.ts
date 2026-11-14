import * as workspace from './workspace.ts';
import * as conversation from './conversation.ts';
import * as preferences from './preferences.ts';
import * as shell from './shell.ts';
import * as resourceContent from './resource-content.ts';
import * as maps from './maps.ts';

export const zhCN = { ...workspace.zhCN, ...conversation.zhCN, ...preferences.zhCN, ...shell.zhCN, ...resourceContent.zhCN, ...maps.zhCN } as const;
export type TranslationKey = keyof typeof zhCN;
export const enUS: Record<TranslationKey, string> = { ...workspace.enUS, ...conversation.enUS, ...preferences.enUS, ...shell.enUS, ...resourceContent.enUS, ...maps.enUS };
