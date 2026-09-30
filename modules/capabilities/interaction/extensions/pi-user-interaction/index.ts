import crypto from 'node:crypto';
import { Type } from 'typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const AskOptionSchema = Type.Object({
  value: Type.String({ minLength: 1, maxLength: 200 }),
  label: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.Optional(Type.String({ maxLength: 500 })),
}, { additionalProperties: false });

const TauAskUserSchema = Type.Object({
  kind: Type.Union([Type.Literal('confirm'), Type.Literal('select'), Type.Literal('input'), Type.Literal('editor')]),
  title: Type.String({ minLength: 1, maxLength: 300 }),
  message: Type.String({ minLength: 1, maxLength: 2000 }),
  options: Type.Optional(Type.Array(AskOptionSchema, { minItems: 2, maxItems: 20 })),
  required: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

type InteractionKind = 'confirm' | 'select' | 'input' | 'editor';
type AskOption = { value: string; label: string; description?: string };

function generatedId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

function requiredText(value: unknown, field: string) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new Error(`${field} is required`);
  return text;
}

function dialogTitle(title: string, message: string) {
  return `${title} — ${message}`;
}

function validateOptions(value: unknown): Array<AskOption & { display: string }> {
  if (!Array.isArray(value) || value.length < 2 || value.length > 20) throw new Error('select requires 2 to 20 options');
  const values = new Set<string>();
  const displays = new Set<string>();
  return value.map((candidate, index) => {
    const option = candidate && typeof candidate === 'object' ? candidate as Record<string, unknown> : {};
    const item: AskOption = {
      value: requiredText(option.value, `options[${index}].value`),
      label: requiredText(option.label, `options[${index}].label`),
      ...(typeof option.description === 'string' && option.description.trim() ? { description: option.description.trim() } : {}),
    };
    const display = item.description ? `${item.label} — ${item.description}` : item.label;
    if (values.has(item.value)) throw new Error(`Duplicate option value: ${item.value}`);
    if (displays.has(display)) throw new Error(`Duplicate option label: ${display}`);
    values.add(item.value);
    displays.add(display);
    return { ...item, display };
  });
}

export default function userInteractionExtension(pi: ExtensionAPI) {
  let interactionPending = false;

  pi.registerTool({
    name: 'tau_ask_user',
    label: 'Ask User',
    description: 'Pause and ask the user for a confirmation, one choice, short text, or long text. Use this instead of guessing required information.',
    promptSnippet: 'Ask the user a structured question and wait for the answer',
    promptGuidelines: [
      'Use tau_ask_user when required information or approval is missing; never infer an answer from silence or cancellation.',
      'Only the host Pi agent should call tau_ask_user. Subagents should report that input is needed to the host.',
    ],
    executionMode: 'sequential',
    parameters: TauAskUserSchema,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (!ctx.hasUI) throw new Error('tau_ask_user requires an interactive TUI or RPC client');
      if (interactionPending) throw new Error('Another user interaction is already pending');
      const kind = params.kind as InteractionKind;
      const title = requiredText(params.title, 'title');
      const message = requiredText(params.message, 'message');
      const interactionId = generatedId('interaction');
      interactionPending = true;
      try {
        onUpdate?.({
          content: [{ type: 'text', text: `等待用户回答：${title}` }],
          details: { kind: 'tau-interaction', interactionId, interactionKind: kind, status: 'waiting' },
        });

        let status: 'answered' | 'cancelled' = 'answered';
        let value: string | boolean | undefined;
        let answerText = '';
        if (signal?.aborted) {
          status = 'cancelled';
        } else if (kind === 'confirm') {
          value = await ctx.ui.confirm(title, message, { signal });
          answerText = value ? '用户选择：是。' : '用户选择：否。';
        } else if (kind === 'select') {
          const options = validateOptions(params.options);
          const selected = await ctx.ui.select(dialogTitle(title, message), options.map((option) => option.display), { signal });
          const option = options.find((candidate) => candidate.display === selected);
          if (option) {
            value = option.value;
            answerText = `用户选择：${option.label}（${option.value}）。`;
          } else if (selected?.trim()) {
            value = selected.trim();
            answerText = `用户回答：${value}`;
          } else {
            status = 'cancelled';
          }
        } else if (kind === 'input') {
          value = await ctx.ui.input(dialogTitle(title, message), undefined, { signal });
          if (value === undefined) status = 'cancelled';
          else answerText = `用户回答：${value}`;
        } else {
          value = await ctx.ui.editor(dialogTitle(title, message));
          if (value === undefined) status = 'cancelled';
          else answerText = `用户回答：${value}`;
        }
        if (signal?.aborted) status = 'cancelled';
        if (status === 'cancelled') {
          answerText = params.required
            ? '用户取消了必需的输入；不要继续依赖该信息。'
            : '用户取消了本次输入。';
          value = undefined;
        }
        return {
          content: [{ type: 'text' as const, text: answerText }],
          details: {
            kind: 'tau-interaction' as const,
            interactionId,
            interactionKind: kind,
            status,
            ...(value !== undefined ? { value } : {}),
          },
        };
      } finally {
        interactionPending = false;
      }
    },
  });
}
