import assert from 'node:assert/strict';
import { test } from 'node:test';

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
    'context',
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
      'Read-only mode ON - edit/write/replace/insert blocked, bash restricted to approved commands',
      'info',
    ],
    ['send-user-message', 'review this'],
  ]);
});
