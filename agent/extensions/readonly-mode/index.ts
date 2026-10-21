/**
 * Read-only mode extension for pi.
 *
 * Pi lifecycle hooks are adapters. Safety policy, state transitions, state
 * restoration, prompt facts, and block reasons live in enforcement.ts.
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  createReadonlyEnforcement,

  type ReadonlyEffect,
  type StateEntry,
} from './enforcement.ts';

const READONLY_FLAG = 'readonly';
const READONLY_COMMAND = 'readonly';
const READONLY_SHORTCUT = 'ctrl+alt+r';
const STATE_ENTRY = 'readonly-mode';
/** System-prompt section tag for the read-only instructions. */
const SECTION_NAME = 'readonly-mode';
const STATUS_KEY = 'readonly-mode';

export default function readonlyMode(pi: ExtensionAPI): void {
  const enforcement = createReadonlyEnforcement();

  pi.registerFlag(READONLY_FLAG, {
    description: 'Start in read-only mode (exploration, planning, code review)',
    type: 'boolean',
    default: false,
  });

  const applyEffects = (
    effects: ReadonlyEffect[],
    ctx?: ExtensionContext,
  ): unknown => {
    let eventResult: unknown;

    for (const effect of effects) {
      switch (effect.type) {
        case 'set-status':
          ctx?.ui.setStatus(STATUS_KEY, effect.text);
          break;
        case 'persist':
          pi.appendEntry(STATE_ENTRY, effect.data);
          break;
        case 'notify':
          ctx?.ui.notify(effect.message, effect.level);
          break;
        case 'send-user-message':
          pi.sendUserMessage(effect.content);
          break;
        case 'block-tool':
          eventResult = { block: true, reason: effect.reason };
          break;
        case 'set-section':
          eventResult = effect.content;
          break;
      }
    }

    return eventResult;
  };

  pi.registerCommand(READONLY_COMMAND, {
    description: 'Toggle read-only mode',
    handler: async (args, ctx) => {
      applyEffects(
        enforcement.handle({ type: 'toggle', prompt: args?.trim() || undefined }),
        ctx,
      );
    },
  });

  pi.registerShortcut(READONLY_SHORTCUT, {
    description: 'Toggle read-only mode',
    handler: async (ctx) => {
      applyEffects(enforcement.handle({ type: 'toggle' }), ctx);
    },
  });

  pi.on('tool_call', async (event, ctx) =>
    applyEffects(
      enforcement.handle({
        type: 'tool-call',
        toolName: event.toolName,
        input: event.input,
      }),
      ctx,
    ) as { block: true; reason?: string } | undefined,
  );

  // The read-only instructions ride the structured system prompt: the section
  // is contributed while enabled and removed (null) while disabled. Pi diffs
  // sections against the transcript, so the instructions persist once as a
  // system-message patch instead of a per-run custom message copy, and the
  // old context-filter cleanup path disappears entirely.
  pi.on('before_agent_start', async (event) => {
    const content = applyEffects(
      enforcement.handle({ type: 'before-agent-start' }),
    ) as string | null | undefined;
    if (content === undefined) return undefined;
    event.systemPromptOptions.sections[SECTION_NAME] = content;
    return undefined;
  });

  pi.on('session_start', async (_event, ctx) => {
    applyEffects(
      enforcement.handle({
        type: 'restore',
        readonlyFlag: pi.getFlag(READONLY_FLAG) === true,
        entries: ctx.sessionManager.getBranch() as StateEntry[],
      }),
      ctx,
    );
  });

  pi.on('session_tree', async (_event, ctx) => {
    applyEffects(
      enforcement.handle({
        type: 'restore-branch',
        entries: ctx.sessionManager.getBranch() as StateEntry[],
      }),
      ctx,
    );
  });
}
