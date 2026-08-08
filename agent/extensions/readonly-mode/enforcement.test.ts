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
        message: 'Read-only mode ON - edit/write/replace blocked, bash restricted to approved commands',
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

  test('blocks built-in file mutation tools but leaves custom tools outside its scope', () => {
    const enforcement = createReadonlyEnforcement();
    enforcement.handle({ type: 'toggle' });

    for (const toolName of ['edit', 'write', 'replace', 'undo_last_replace']) {
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

  test('allows read-only shell commands and validates every compound segment', () => {
    const enforcement = createReadonlyEnforcement();
    enforcement.handle({ type: 'toggle' });

    for (const command of [
      'rg -n "TODO" agent | head -20',
      'git status && git diff -- README.md',
      'FOO=bar env | sort',
      'eslint src',
      'tsc --noEmit',
      'cd agent; pwd',
      'printf "%s\\n" "a;b"',
    ]) {
      assert.deepEqual(
        enforcement.handle({ type: 'tool-call', toolName: 'bash', input: { command } }),
        [],
        command,
      );
    }
  });

  test('rejects unsafe or ambiguous shell syntax fail-closed', () => {
    const enforcement = createReadonlyEnforcement();
    enforcement.handle({ type: 'toggle' });

    for (const command of [
      '',
      'git status && rm -rf tmp',
      'echo $(touch marker)',
      'echo `touch marker`',
      'rg TODO > result.txt',
      'rg TODO &',
      'cat <(generate-report)',
      'unknown-command --read-only',
      'env rm -rf tmp',
      'PATH=/tmp env rg TODO',
      '/tmp/rg TODO',
      'find . -delete',
      'sort -o result.txt input.txt',
    ]) {
      const effects = enforcement.handle({
        type: 'tool-call',
        toolName: 'bash',
        input: { command },
      });

      assert.equal(effects[0]?.type, 'block-tool', command);
    }
  });

  test('uses command-specific policies for version control, network, and package tools', () => {
    const enforcement = createReadonlyEnforcement();
    enforcement.handle({ type: 'toggle' });

    for (const command of [
      'git log --oneline -5',
      'git branch --list "feature/*"',
      'git remote -v',
      'curl -fsSL https://example.com',
      'wget -qO- https://example.com',
      'npm test',
      'npm run lint',
      'pnpm typecheck',
      'cargo test',
      'go vet ./...',
      'pytest -q',
    ]) {
      assert.deepEqual(
        enforcement.handle({ type: 'tool-call', toolName: 'bash', input: { command } }),
        [],
        command,
      );
    }

    for (const command of [
      'git clean -fd',
      'git branch new-branch',
      'git remote -v add origin https://example.com/repo.git',
      'git config --list --unset user.name',
      'curl -o result.json https://example.com',
      'curl -sSLo result.json https://example.com',
      'curl --json "{}" https://example.com',
      'curl -X POST https://example.com',
      'wget https://example.com',
      'wget -qO- -o wget.log https://example.com',
      'npm install',
      'npm audit --fix',
      'npm run build',
      'npm run deploy',
      'cargo clippy --fix',
      'eslint --fix src',
      'tsc',
      'python script.py',
      'node script.js',
      'xcodebuild test',
    ]) {
      const effects = enforcement.handle({
        type: 'tool-call',
        toolName: 'bash',
        input: { command },
      });

      assert.equal(effects[0]?.type, 'block-tool', command);
    }
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
