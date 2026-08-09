import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { explainUnsafeCommand, isSafeShellCommand } from './policy.ts';

describe('read-only command policy', () => {
  test('allows read-only shell commands and validates every compound segment', () => {
    for (const command of [
      'rg -n "TODO" agent | head -20',
      'git status && git diff -- README.md',
      'FOO=bar env | sort',
      'eslint src',
      'tsc --noEmit',
      'cd agent; pwd',
      'printf "%s\\n" "a;b"',
      'ls -la',
      'diff README.md CONTEXT.md',
    ]) {
      assert.equal(isSafeShellCommand(command), true, command);
    }
  });

  test('rejects unsafe or ambiguous shell syntax fail-closed', () => {
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
      'diff --output=result.txt a b',
    ]) {
      assert.equal(isSafeShellCommand(command), false, command);
    }
  });

  test('uses command-specific policies for version control, network, and package tools', () => {
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
      assert.equal(isSafeShellCommand(command), true, command);
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
      assert.equal(isSafeShellCommand(command), false, command);
    }
  });

  test('drafting profile keeps per-segment parsing but forbids network commands', () => {
    for (const command of [
      'git log --oneline -5 | head -3',
      'rg -n "TODO" agent | wc -l',
      'git status && git diff -- README.md',
      'pwd && git status --short',
      'pwd && ls -la',
      'jq .name agent/npm/package.json',
      'npm test',
      'pytest -q',
    ]) {
      assert.equal(isSafeShellCommand(command, 'drafting'), true, command);
    }

    for (const command of [
      'curl -fsSL https://example.com',
      'wget -qO- https://example.com',
      'ping -c 1 example.com',
      'nslookup example.com',
      'traceroute example.com',
      'whois example.com',
      'host example.com',
      'env curl -fsSL https://example.com',
      'timeout 5 curl -fsSL https://example.com',
      'git status && rm -rf tmp',
      'echo $(touch marker)',
      "pwd && printf '%s\\n' '--- files ---' && rg --files -g '!node_modules' -g '!.git' | sed -n '1,240p' && git status --short",
      'pwd\nrm -rf /tmp/drafting-escape',
    ]) {
      assert.equal(isSafeShellCommand(command, 'drafting'), false, command);
    }

    // The same network reads stay allowed under the standard profile.
    assert.equal(isSafeShellCommand('curl -fsSL https://example.com'), true);
    assert.equal(isSafeShellCommand('ping -c 1 example.com', 'standard'), true);
  });

  test('names the rejected segment so callers can explain the block', () => {
    assert.equal(explainUnsafeCommand('pwd && git status'), undefined);

    assert.deepEqual(explainUnsafeCommand('pwd && rm -rf tmp'), {
      kind: 'segment',
      segment: 'rm -rf tmp',
    });
    assert.deepEqual(explainUnsafeCommand('git status && curl https://example.com', 'drafting'), {
      kind: 'segment',
      segment: 'curl https://example.com',
    });
    // Quotes are stripped: the segment is the parsed argv, not a verbatim slice.
    assert.deepEqual(explainUnsafeCommand('rg TODO | sed -n "1,5p"'), {
      kind: 'segment',
      segment: 'sed -n 1,5p',
    });

    for (const command of ['', 'echo $(touch marker)', 'rg TODO > result.txt', "cat 'unbalanced"]) {
      assert.deepEqual(explainUnsafeCommand(command), { kind: 'unparsable' }, command);
    }
  });
});
