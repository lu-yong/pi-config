/**
 * Read-only mode extension for pi.
 *
 * Provides a lightweight toggle (/readonly, --readonly) that restricts
 * the agent to read-only tools — perfect for:
 *   - "Grill me" code reviews & deep-dive questioning
 *   - Implementation planning & design discussion
 *   - Architecture exploration & tech-debt analysis
 *   - General codebase navigation & learning
 *
 * Based on: https://github.com/azzgo/dotfiles/tree/main/pi/agent/extensions/readonly-mode
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { CONTEXT_ENTRY, READONLY_CMD, READONLY_FLAG, READONLY_SHORTCUT } from './constants.js';
import { ReadonlyController } from './controller.js';
import { getReadonlyInstructions } from './prompt.js';
import type { StateEntry } from './state.js';
import { isSafeCommand } from './utils.js';

export default function readonlyMode(pi: ExtensionAPI): void {
  const readonlyCtrl = new ReadonlyController(pi);

  // ── CLI flag ──────────────────────────────────────────────────
  pi.registerFlag(READONLY_FLAG, {
    description: 'Start in read-only mode (exploration, planning, code review)',
    type: 'boolean',
    default: false,
  });

  function toggleReadonly(ctx: ExtensionContext): boolean {
    if (readonlyCtrl.isEnabled()) {
      readonlyCtrl.exit(ctx);
      return false;
    }

    readonlyCtrl.enter(ctx);
    return true;
  }

  // ── Slash command ─────────────────────────────────────────────
  pi.registerCommand(READONLY_CMD, {
    description: 'Toggle read-only mode',
    handler: async (args, ctx) => {
      if (!toggleReadonly(ctx)) return;

      const prompt = args?.trim();
      if (prompt) {
        pi.sendUserMessage(prompt);
      }
    },
  });

  // ── Keyboard shortcut ─────────────────────────────────────────
  pi.registerShortcut(READONLY_SHORTCUT, {
    description: 'Toggle read-only mode',
    handler: async (ctx) => {
      toggleReadonly(ctx);
    },
  });

  // ── Block destructive tool calls ──────────────────────────────
  pi.on('tool_call', async (event) => {
    if (!readonlyCtrl.isEnabled()) return;

    if (event.toolName === 'edit' || event.toolName === 'write') {
      return {
        block: true,
        reason:
          'Read-only mode: file modifications are not allowed. Use /readonly to exit read-only mode first.',
      };
    }

    if (event.toolName === 'bash') {
      const command = (event.input as { command: string }).command;
      if (!isSafeCommand(command)) {
        return {
          block: true,
          reason: `Read-only mode: command blocked. Only read-only commands are allowed.\nCommand: ${command}\nUse /readonly to exit read-only mode first.`,
        };
      }
    }
  });

  // ── Inject context message on each turn ───────────────────────
  pi.on('before_agent_start', async () => {
    if (!readonlyCtrl.isEnabled()) return;

    return {
      message: {
        customType: CONTEXT_ENTRY,
        content: getReadonlyInstructions(),
        display: false,
      },
    };
  });

  // ── Filter out stale context entries when mode is off ─────────
  pi.on('context', async (event) => {
    if (readonlyCtrl.isEnabled()) return;

    return {
      messages: event.messages.filter((message) => {
        const msg = message as typeof message & { customType?: string };
        return msg.customType !== CONTEXT_ENTRY;
      }),
    };
  });

  // ── Restore state on session start ────────────────────────────
  pi.on('session_start', async (_event, ctx) => {
    if (pi.getFlag(READONLY_FLAG) === true) {
      readonlyCtrl.enableFromFlag();
    }

    readonlyCtrl.restore(ctx, ctx.sessionManager.getEntries() as StateEntry[]);
  });

  // ── Reset & restore on tree navigation ────────────────────────
  pi.on('session_tree', async (_event, ctx) => {
    readonlyCtrl.reset();
    const entries = (ctx.sessionManager.getBranch?.() ??
      ctx.sessionManager.getEntries()) as StateEntry[];
    readonlyCtrl.restore(ctx, entries);
  });
}
