import type {ProviderModel} from './types';
import {fallbackModel} from './model-catalog';

// Browser fixtures only; the desktop always reads its installed OpenCode catalog.
export const openCodePreviewModels: ProviderModel[] = [
  {id:'opencode/big-pickle',name:'Big Pickle',description:'opencode/big-pickle',contextWindow:200000},
  {id:'anthropic/claude-sonnet-4-6',name:'Claude Sonnet 4.6',description:'anthropic/claude-sonnet-4-6',contextWindow:200000},
  {id:'openai/gpt-5.4',name:'GPT-5.4',description:'openai/gpt-5.4',contextWindow:1050000},
];
export const openCodePreviewKey = 'pandacode.preview.opencode-models';
export function previewOpenCodeSelection(): string[] {
  try {
    const stored = JSON.parse(localStorage.getItem(openCodePreviewKey) || '[]');
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string' && id.includes('/') && id.length <= 200) : [];
  } catch { return []; }
}
export function previewOpenCodeChoices(): ProviderModel[] {
  return [fallbackModel('opencode'), ...previewOpenCodeSelection().map(id => openCodePreviewModels.find(model => model.id === id) ?? fallbackModel('opencode', id))];
}
