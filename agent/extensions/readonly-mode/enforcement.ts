import { isSafeShellCommand } from '../command-policy/policy.ts';

export interface StateEntry {
  type: string;
  customType?: string;
  data?: unknown;
}

export type ContextMessage = object & {
  customType?: string;
  role?: string;
  content?: string;
};

export type ReadonlyEvent =
  | { type: 'toggle'; prompt?: string }
  | { type: 'tool-call'; toolName: string; input: unknown }
  | { type: 'before-agent-start' }
  | { type: 'context'; messages: ContextMessage[] }
  | { type: 'restore'; readonlyFlag: boolean; entries: StateEntry[] }
  | { type: 'restore-branch'; entries: StateEntry[] };

export type ReadonlyEffect =
  | { type: 'set-status'; text: string | undefined }
  | { type: 'persist'; data: { readonlyMode: boolean } }
  | { type: 'notify'; message: string; level: 'info' }
  | { type: 'send-user-message'; content: string }
  | { type: 'block-tool'; reason: string }
  | { type: 'inject-context'; content: string }
  | { type: 'replace-context'; messages: ContextMessage[] };

export interface ReadonlyEnforcement {
  handle(event: ReadonlyEvent): ReadonlyEffect[];
}

const STATE_ENTRY = 'readonly-mode';
const CONTEXT_ENTRY = 'readonly-mode-context';

// File-mutating tools blocked in read-only mode. 'edit' and 'write' are pi built-ins;
// the anchor editing and undo tools are registered by pi-hashline-edit-pro, which also
// disables the built-in 'edit' tool. 'undo_last_replace' is kept for older pi builds.
// tool_call covers both direct and nested calls (e.g. through codemode).
const FILE_MUTATION_TOOLS: ReadonlySet<string> = new Set([
  'edit',
  'write',
  'replace',
  'replace_match',
  'insert',
  'copy',
  'move',
  'undo_last_change',
  'undo_last_replace',
]);
const FILE_MUTATION_REASON =
  'Read-only mode: file modifications are not allowed. Use /readonly to exit read-only mode first.';

const READONLY_INSTRUCTIONS = `[READ-ONLY MODE ACTIVE]
You are in local read-only mode for exploration, planning, code review, and architecture analysis.

Enforced core-tool restrictions:
- File-mutating tools are blocked, including nested calls: pi's built-in edit and write, plus the pi-hashline-edit-pro replace, replace_match, insert, copy, move, and undo_last_change tools, and legacy undo_last_replace.
- Bash commands are fail-closed. Approved read commands, tests, and static checks are allowed; installs, builds, publishing, arbitrary scripts, all redirection except stderr to /dev/null (2>/dev/null), background execution, and command substitution are blocked.
- Every segment of a pipeline or compound command is checked independently.
- Pi's built-in read, grep, find, and ls tools remain available.

Scope:
- MCP, skills, and other custom tools are outside this mode's enforcement scope and may modify external systems.
- This mode protects local files from the intercepted core tools; it is not a global no-side-effect sandbox.

Tests and static checks are allowed and may create their normal caches or temporary artifacts.
You may propose changes and show code snippets, but do not attempt local file changes through blocked core tools.`;

class Enforcement implements ReadonlyEnforcement {
  private enabled = false;
  private flagOverrideActive = false;

  handle(event: ReadonlyEvent): ReadonlyEffect[] {
    switch (event.type) {
      case 'toggle':
        return this.toggle(event.prompt);
      case 'tool-call':
        return this.handleToolCall(event.toolName, event.input);
      case 'before-agent-start':
        return this.enabled
          ? [{ type: 'inject-context', content: READONLY_INSTRUCTIONS }]
          : [];
      case 'context':
        return this.handleContext(event.messages);
      case 'restore':
        return this.restore(event.entries, event.readonlyFlag);
      case 'restore-branch':
        return this.restoreBranch(event.entries);
    }
  }

  private toggle(prompt?: string): ReadonlyEffect[] {
    this.enabled = !this.enabled;
    if (!this.enabled) this.flagOverrideActive = false;

    const effects: ReadonlyEffect[] = [
      { type: 'set-status', text: this.enabled ? '🛡️ readonly' : undefined },
      { type: 'persist', data: { readonlyMode: this.enabled } },
      this.enabled
        ? {
            type: 'notify',
            level: 'info',
            message: 'Read-only mode ON - edit/write/replace/replace_match/insert/copy/move/undo_last_change/undo_last_replace blocked, bash restricted to approved commands',
          }
        : {
            type: 'notify',
            level: 'info',
            message: 'Read-only mode OFF - full tool access restored',
          },
    ];

    if (this.enabled && prompt?.trim()) {
      effects.push({ type: 'send-user-message', content: prompt.trim() });
    }

    return effects;
  }

  private handleToolCall(toolName: string, input: unknown): ReadonlyEffect[] {
    if (!this.enabled) return [];

    if (FILE_MUTATION_TOOLS.has(toolName)) {
      return [{ type: 'block-tool', reason: FILE_MUTATION_REASON }];
    }

    if (toolName !== 'bash') return [];

    const command = readCommand(input);
    if (command !== undefined && isSafeShellCommand(command)) return [];

    const shownCommand = command ?? '<invalid bash input>';
    return [
      {
        type: 'block-tool',
        reason: `Read-only mode: command blocked. Only approved read-only, test, and static-check commands are allowed.\nCommand: ${shownCommand}\nUse /readonly to exit read-only mode first.`,
      },
    ];
  }

  private handleContext(messages: ContextMessage[]): ReadonlyEffect[] {
    if (this.enabled) return [];

    const filtered = messages.filter((message) => message.customType !== CONTEXT_ENTRY);
    return filtered.length === messages.length
      ? []
      : [{ type: 'replace-context', messages: filtered }];
  }

  private restore(entries: StateEntry[], readonlyFlag: boolean): ReadonlyEffect[] {
    const saved = findSavedState(entries);
    this.flagOverrideActive = readonlyFlag;
    this.enabled = readonlyFlag || saved || false;

    const effects: ReadonlyEffect[] = [
      { type: 'set-status', text: this.enabled ? '🛡️ readonly' : undefined },
    ];
    if (readonlyFlag && saved !== true) {
      effects.push({ type: 'persist', data: { readonlyMode: true } });
    }
    return effects;
  }

  private restoreBranch(entries: StateEntry[]): ReadonlyEffect[] {
    const saved = findSavedState(entries);
    this.enabled = this.flagOverrideActive || saved || false;
    return [{ type: 'set-status', text: this.enabled ? '🛡️ readonly' : undefined }];
  }
}

export function createReadonlyEnforcement(): ReadonlyEnforcement {
  return new Enforcement();
}

function readCommand(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null || !('command' in input)) return undefined;
  const command = (input as { command?: unknown }).command;
  return typeof command === 'string' ? command : undefined;
}

function findSavedState(entries: StateEntry[]): boolean | undefined {
  let saved: boolean | undefined;
  for (const entry of entries) {
    if (entry.type !== 'custom' || entry.customType !== STATE_ENTRY) continue;
    if (!isPersistedState(entry.data)) continue;
    saved = entry.data.readonlyMode;
  }
  return saved;
}

function isPersistedState(value: unknown): value is { readonlyMode: boolean } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'readonlyMode' in value &&
    typeof (value as { readonlyMode?: unknown }).readonlyMode === 'boolean'
  );
}
