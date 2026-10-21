import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createExtensionRuntime,
  ExtensionRunner,
  SessionManager,
  type ToolCallEvent,
} from '@earendil-works/pi-coding-agent';
import readonlyMode from './index.ts';

test('Pi adapter registers the public controls and lifecycle hooks', () => {
  const events = new Map<string, (...args: any[]) => unknown>();
  const commands = new Map<string, { handler: (...args: any[]) => unknown }>();
  const shortcuts = new Map<string, { handler: (...args: any[]) => unknown }>();
  const flags = new Map<string, unknown>();

  const pi = {
    on: (name: string, handler: (...args: any[]) => unknown) => events.set(name, handler),
    registerCommand: (name: string, command: { handler: (...args: any[]) => unknown }) =>
      commands.set(name, command),
    registerShortcut: (name: string, shortcut: { handler: (...args: any[]) => unknown }) =>
      shortcuts.set(name, shortcut),
    registerFlag: (name: string, flag: unknown) => flags.set(name, flag),
    appendEntry: () => undefined,
    getFlag: () => false,
    sendUserMessage: () => undefined,
  };

  readonlyMode(pi as never);

  assert.deepEqual([...flags.keys()], ['readonly']);
  assert.deepEqual([...commands.keys()], ['readonly']);
  assert.deepEqual([...shortcuts.keys()], ['ctrl+alt+r']);
  assert.deepEqual([...events.keys()], [
    'tool_call',
    'before_agent_start',
    'session_start',
    'session_tree',
  ]);
});

test('Pi adapter restores state from the active branch only', async () => {
  const events = new Map<string, (...args: any[]) => unknown>();
  const statuses: Array<string | undefined> = [];
  const state = (readonlyMode: boolean) => ({
    type: 'custom',
    customType: 'readonly-mode',
    data: { readonlyMode },
  });

  const pi = {
    on: (name: string, handler: (...args: any[]) => unknown) => events.set(name, handler),
    registerCommand: () => undefined,
    registerShortcut: () => undefined,
    registerFlag: () => undefined,
    appendEntry: () => undefined,
    getFlag: () => false,
    sendUserMessage: () => undefined,
  };
  const ctx = {
    ui: {
      setStatus: (_key: string, text: string | undefined) => statuses.push(text),
      notify: () => undefined,
    },
    sessionManager: {
      getEntries: () => [state(false), state(true)],
      getBranch: () => [state(false)],
    },
  };

  readonlyMode(pi as never);
  await events.get('session_start')?.({}, ctx);

  assert.deepEqual(statuses, [undefined]);
});

test('Pi adapter applies toggle effects in order', async () => {
  const calls: unknown[] = [];
  let commandHandler: ((args: string, ctx: unknown) => Promise<void>) | undefined;

  const pi = {
    on: () => undefined,
    registerCommand: (_name: string, command: { handler: typeof commandHandler }) => {
      commandHandler = command.handler;
    },
    registerShortcut: () => undefined,
    registerFlag: () => undefined,
    appendEntry: (customType: string, data: unknown) => calls.push(['persist', customType, data]),
    getFlag: () => false,
    sendUserMessage: (content: string) => calls.push(['send-user-message', content]),
  };
  const ctx = {
    ui: {
      setStatus: (key: string, text: string | undefined) => calls.push(['status', key, text]),
      notify: (message: string, level: string) => calls.push(['notify', message, level]),
    },
  };

  readonlyMode(pi as never);
  await commandHandler?.('review this', ctx);

  assert.deepEqual(calls, [
    ['status', 'readonly-mode', '🛡️ readonly'],
    ['persist', 'readonly-mode', { readonlyMode: true }],
    [
      'notify',
      'Read-only mode ON - edit/write/replace/replace_match/insert/copy/move/undo_last_change/undo_last_replace blocked, bash restricted to approved commands',
      'info',
    ],
    ['send-user-message', 'review this'],
  ]);
});

// Keep policy assertions at Pi's real event-dispatch boundary, not just enforcement.handle().
function createReadonlyRunner() {
  const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
  let toggle: (args: string, ctx: any) => Promise<void>;
  readonlyMode({
    on: (name: string, handler: (...args: any[]) => unknown) => handlers.set(name, [handler]),
    registerCommand: (_name: string, command: { handler: typeof toggle }) => {
      toggle = command.handler;
    },
    registerShortcut: () => undefined,
    registerFlag: () => undefined,
    appendEntry: () => undefined,
    getFlag: () => false,
    sendUserMessage: () => undefined,
  } as never);

  const runner = new ExtensionRunner(
    [{ path: 'readonly-mode', handlers } as never],
    createExtensionRuntime(),
    process.cwd(),
    SessionManager.inMemory(),
    {} as never, // No model access is needed for tool_call dispatch.
  );
  return { runner, toggle: () => toggle('', runner.createContext()) };
}

const mutationInputs: Record<string, Record<string, unknown>> = {
  edit: { path: 'example.txt', oldText: 'old', newText: 'new' },
  write: { path: 'example.txt', content: 'new' },
  replace: { remove_from: 'abcd', remove_to: 'abcd', text: 'new' },
  replace_match: { replace_from: 'abcd', replace_to: 'abcd', old_string: 'old', new_string: 'new' },
  insert: { anchor: 'abcd', direction: 'after', text: 'new' },
  copy: { source_from: 'abcd', source_to: 'abcd', insert_after: 'efgh' },
  move: { source_from: 'abcd', source_to: 'abcd', insert_after: 'efgh' },
  undo_last_change: { path: 'example.txt' },
  undo_last_replace: { path: 'example.txt' },
};

for (const parentToolCallId of [undefined, 'codemode-call']) {
  const route = parentToolCallId ? 'nested' : 'direct';
  const toolEvent = (toolName: string, input: Record<string, unknown>): ToolCallEvent => ({
    type: 'tool_call',
    toolName,
    toolCallId: parentToolCallId ? `${parentToolCallId}/1` : 'model-call',
    ...(parentToolCallId ? { parentToolCallId } : {}),
    input,
  });

  for (const [toolName, input] of Object.entries(mutationInputs)) {
    test(`Pi runner blocks ${route} ${toolName} only while readonly is enabled`, async () => {
      const { runner, toggle } = createReadonlyRunner();
      const event = toolEvent(toolName, input);
      assert.equal(await runner.emitToolCall(event), undefined);
      await toggle();
      assert.deepEqual(await runner.emitToolCall(event), {
        block: true,
        reason: 'Read-only mode: file modifications are not allowed. Use /readonly to exit read-only mode first.',
      });
      await toggle();
      assert.equal(await runner.emitToolCall(event), undefined);
    });
  }

  test(`Pi runner preserves ${route} non-mutating and custom tool boundaries`, async () => {
    const { runner, toggle } = createReadonlyRunner();
    await toggle();
    for (const toolName of ['read', 'grep', 'find', 'ls', 'anchor_grep', 'custom_deploy', 'codemode', 'mcp__example__write']) {
      assert.equal(await runner.emitToolCall(toolEvent(toolName, {})), undefined, toolName);
    }
  });

  test(`Pi runner preserves ${route} bash command policy`, async () => {
    const { runner, toggle } = createReadonlyRunner();
    await toggle();
    for (const command of ['git status && git diff -- README.md', 'npm test', 'tsc --noEmit']) {
      assert.equal(await runner.emitToolCall(toolEvent('bash', { command })), undefined, command);
    }
    for (const input of [{ command: 'git status && rm -rf tmp' }, { command: 'echo changed > example.txt' }, { command: 'node script.js' }, {}]) {
      const result = await runner.emitToolCall(toolEvent('bash', input));
      assert.equal(result?.block, true);
      assert.match(result?.reason ?? '', /Read-only mode: command blocked/);
    }
  });
}
