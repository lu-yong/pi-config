import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createReadonlyEnforcement } from './enforcement.ts';

const savedState = (readonlyMode: boolean) => ({
  type: 'custom',
  customType: 'readonly-mode',
  data: { readonlyMode },
});

describe('read-only enforcement', () => {
  test('starts disabled and leaves tools and context unchanged', () => {
    const enforcement = createReadonlyEnforcement();

    assert.deepEqual(
      enforcement.handle({ type: 'tool-call', toolName: 'edit', input: {} }),
      [],
    );
    assert.deepEqual(
      enforcement.handle({
        type: 'context',
        messages: [{ role: 'user', content: 'keep me' }],
      }),
      [],
    );
  });

  test('toggle owns status, persistence, notification, and follow-up ordering', () => {
    const enforcement = createReadonlyEnforcement();

    assert.deepEqual(enforcement.handle({ type: 'toggle', prompt: 'review this' }), [
      { type: 'set-status', text: '🛡️ readonly' },
      { type: 'persist', data: { readonlyMode: true } },
      {
        type: 'notify',
        level: 'info',
        message: 'Read-only mode ON - edit/write/replace/replace_match/insert/copy/move/undo_last_change/undo_last_replace blocked, bash restricted to approved commands',
      },
      { type: 'send-user-message', content: 'review this' },
    ]);

    assert.deepEqual(enforcement.handle({ type: 'toggle', prompt: 'ignored' }), [
      { type: 'set-status', text: undefined },
      { type: 'persist', data: { readonlyMode: false } },
      {
        type: 'notify',
        level: 'info',
        message: 'Read-only mode OFF - full tool access restored',
      },
    ]);
  });

  test('blocks file mutation tools including hashline-pro edit tools but leaves custom tools outside its scope', () => {
    const enforcement = createReadonlyEnforcement();
    enforcement.handle({ type: 'toggle' });

    for (const toolName of ['edit', 'write', 'replace', 'replace_match', 'insert', 'copy', 'move', 'undo_last_change', 'undo_last_replace']) {
      assert.deepEqual(
        enforcement.handle({ type: 'tool-call', toolName, input: {} }),
        [
          {
            type: 'block-tool',
            reason:
              'Read-only mode: file modifications are not allowed. Use /readonly to exit read-only mode first.',
          },
        ],
      );
    }

    assert.deepEqual(
      enforcement.handle({ type: 'tool-call', toolName: 'custom_deploy', input: {} }),
      [],
    );
  });

  test('routes bash commands through the shared command policy', () => {
    const enforcement = createReadonlyEnforcement();
    enforcement.handle({ type: 'toggle' });

    assert.deepEqual(
      enforcement.handle({
        type: 'tool-call',
        toolName: 'bash',
        input: { command: 'git status && git diff -- README.md' },
      }),
      [],
    );

    const effects = enforcement.handle({
      type: 'tool-call',
      toolName: 'bash',
      input: { command: 'git status && rm -rf tmp' },
    });
    assert.equal(effects[0]?.type, 'block-tool');

    const invalidInput = enforcement.handle({ type: 'tool-call', toolName: 'bash', input: {} });
    assert.equal(invalidInput[0]?.type, 'block-tool');
  });

  test('restores the latest valid branch state and ignores malformed entries', () => {
    const enforcement = createReadonlyEnforcement();

    assert.deepEqual(
      enforcement.handle({
        type: 'restore',
        readonlyFlag: false,
        entries: [
          savedState(true),
          { type: 'custom', customType: 'readonly-mode', data: { readonlyMode: 'no' } },
          savedState(false),
          { type: 'custom', customType: 'other', data: { readonlyMode: true } },
        ],
      }),
      [{ type: 'set-status', text: undefined }],
    );
  });

  test('--readonly overrides saved state until the user explicitly exits', () => {
    const enforcement = createReadonlyEnforcement();

    assert.deepEqual(
      enforcement.handle({
        type: 'restore',
        readonlyFlag: true,
        entries: [savedState(false)],
      }),
      [
        { type: 'set-status', text: '🛡️ readonly' },
        { type: 'persist', data: { readonlyMode: true } },
      ],
    );

    enforcement.handle({ type: 'toggle' });
    assert.deepEqual(
      enforcement.handle({ type: 'restore-branch', entries: [savedState(false)] }),
      [{ type: 'set-status', text: undefined }],
    );
  });

  test('injects current policy facts while enabled and removes stale context when disabled', () => {
    const enforcement = createReadonlyEnforcement();
    enforcement.handle({ type: 'toggle' });

    const injection = enforcement.handle({ type: 'before-agent-start' });
    assert.equal(injection[0]?.type, 'inject-context');
    assert.match(
      injection[0]?.type === 'inject-context' ? injection[0].content : '',
      /Tests and static checks are allowed/,
    );
    assert.match(
      injection[0]?.type === 'inject-context' ? injection[0].content : '',
      /custom tools are outside this mode's enforcement scope/,
    );
    const instructions = injection[0]?.type === 'inject-context' ? injection[0].content : '';
    for (const toolName of ['replace_match', 'copy', 'move', 'undo_last_replace']) {
      assert.match(instructions, new RegExp(`\\b${toolName}\\b`));
    }
    assert.match(instructions, /including nested calls/);

    enforcement.handle({ type: 'toggle' });
    assert.deepEqual(
      enforcement.handle({
        type: 'context',
        messages: [
          { role: 'user', customType: 'readonly-mode-context', content: 'stale' },
          { role: 'user', content: 'keep' },
        ],
      }),
      [
        {
          type: 'replace-context',
          messages: [{ role: 'user', content: 'keep' }],
        },
      ],
    );
  });
});
