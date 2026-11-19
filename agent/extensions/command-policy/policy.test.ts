import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  classifyToolCall,
  explainUnsafeCommand,
  FILE_MUTATION_TOOLS,
  isFileMutationTool,
  isSafeShellCommand,
  NETWORK_COMMANDS,
} from './policy.ts';

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
      'sdiff -w 200 README.md CONTEXT.md',
      'sort README.md',
      'uniq input 2>/dev/null',
      'ls -la /vendor/svd /device/svd 2>/dev/null; ls /workspace 2>/dev/null | head; find /home/luyong -maxdepth 4 -type d \\( -name model -o -name native \\) 2>/dev/null | head -50',
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
      'diff -o result.txt a b',
      'sdiff -o result.txt a b',
      'sdiff --output=result.txt a b',
      'sdiff -oresult.txt a b',
      'ls 2>/dev/nullx',
      'ls 2>/tmp/error.log',
      'ls 2>>/dev/null',
      'ls 1>/dev/null',
      'ls 2 > /dev/null',
      'uniq input "2">/dev/null',
      "uniq input '2'>/dev/null",
      'uniq input \\2>/dev/null',
      "uniq input 2''>/dev/null",
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

  test('gates bun and swift scripts the same way as npm run', () => {
    // `bun run <script>` executes arbitrary package.json scripts, so it must
    // stay behind the APPROVED_SCRIPT whitelist like `npm run` above.
    for (const command of [
      'bun test',
      'bun run lint',
      'bun run test:unit',
      'swift test',
      'swift package describe',
      'swift --version',
    ]) {
      assert.equal(isSafeShellCommand(command), true, command);
    }

    for (const command of [
      'bun run build',
      'bun install',
      'swift build',
    ]) {
      assert.equal(isSafeShellCommand(command), false, command);
    }
  });

  test('blocks output-file write vectors for uniq, yq, and read-only git subcommands', () => {
    for (const command of [
      'uniq input',
      'yq ".a" config.yaml',
    ]) {
      assert.equal(isSafeShellCommand(command), true, command);
    }

    // uniq with two positional arguments writes the second one; yq -i rewrites
    // its input in place; --output turns a read-only git subcommand into a write.
    for (const command of [
      'uniq input output',
      'yq -i ".a=1" config.yaml',
      'yq --in-place ".a=1" config.yaml',
      'git diff --output=result.txt a b',
      'git diff --output result.txt a b',
      'git show --output=result.txt HEAD',
    ]) {
      assert.equal(isSafeShellCommand(command), false, command);
    }
  });

  test('blocks curl upload and disk-write flags beyond -o and --json', () => {
    assert.equal(isSafeShellCommand('curl -X HEAD https://example.com'), true);

    for (const command of [
      'curl -T upload.txt https://example.com',
      'curl --upload-file upload.txt https://example.com',
      'curl -O https://example.com',
      'curl -F name=@file https://example.com',
      'curl -K cfg https://example.com',
      'curl --output-dir out https://example.com',
      'curl --dump-header headers.txt https://example.com',
    ]) {
      assert.equal(isSafeShellCommand(command), false, command);
    }
  });

  test('applies the policy to commands nested under command, time, and timeout', () => {
    for (const command of [
      'command -v rg',
      'command git status',
      'time git status',
      'time -p git status',
      'timeout 5s git status',
    ]) {
      assert.equal(isSafeShellCommand(command), true, command);
    }

    for (const command of [
      'command',
      'command rm -rf tmp',
      'time rm -rf tmp',
      'timeout 5 rm -rf tmp',
    ]) {
      assert.equal(isSafeShellCommand(command), false, command);
    }
  });

  test('allows git global options and read-only subcommand aliases without mutations', () => {
    for (const command of [
      'git -C agent status',
      'git --no-pager log -1',
      'git --paginate status',
      'git --version',
      'git stash list',
      'git stash show',
      'git tag',
      'git tag -l',
      'git worktree list',
      'git reflog',
      'git reflog show',
      'git submodule status',
      'git config --get user.name',
      'git config --list',
      'git remote get-url origin',
    ]) {
      assert.equal(isSafeShellCommand(command), true, command);
    }

    for (const command of [
      'git stash pop',
      'git tag v1.0',
      'git worktree add ../x main',
      'git -C agent push',
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

  test('exported network-command list pins the drafting profile surface', () => {
    // Callers derive user-facing messages from this export; membership is the
    // contract, so an accidental deletion must fail here, not silently shrink
    // the drafting restrictions and every message describing them.
    assert.deepEqual(
      [...NETWORK_COMMANDS].sort(),
      ['curl', 'host', 'nslookup', 'ping', 'traceroute', 'wget', 'whois'],
    );
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

describe('tool call classification', () => {
  test('names every file-mutation tool exactly once', () => {
    assert.deepEqual(
      [...FILE_MUTATION_TOOLS],
      ['edit', 'write', 'replace', 'replace_match', 'insert', 'copy', 'move', 'undo_last_change'],
    );
    for (const toolName of FILE_MUTATION_TOOLS) assert.equal(isFileMutationTool(toolName), true, toolName);
    for (const toolName of ['read', 'grep', 'find', 'ls', 'bash', 'undo_last_replace', 'custom_deploy']) {
      assert.equal(isFileMutationTool(toolName), false, toolName);
    }
  });

  test('reports the written file when the input identifies it', () => {
    for (const toolName of ['edit', 'write', 'replace', 'replace_match', 'insert', 'undo_last_change']) {
      assert.deepEqual(
        classifyToolCall(toolName, { path: 'src/app.ts' }),
        { kind: 'file-mutation', path: 'src/app.ts' },
        toolName,
      );
    }
  });

  test('reports an unknown target for pathless calls and for copy/move even with a path', () => {
    for (const input of [{}, { path: '' }, { path: '   ' }, { path: 7 }, null, 'src/app.ts']) {
      assert.deepEqual(classifyToolCall('replace', input), { kind: 'file-mutation', path: undefined });
    }
    for (const toolName of ['copy', 'move']) {
      assert.deepEqual(
        classifyToolCall(toolName, { path: 'src/app.ts' }),
        { kind: 'file-mutation', path: undefined },
        toolName,
      );
    }
  });

  test('routes bash through the command profiles and fails closed on a missing command', () => {
    assert.deepEqual(classifyToolCall('bash', { command: 'git status && pwd' }), { kind: 'read-only' });
    assert.deepEqual(classifyToolCall('bash', { command: 'git status && rm -rf tmp' }), {
      kind: 'unsafe-command',
      reason: { kind: 'segment', segment: 'rm -rf tmp' },
      command: 'git status && rm -rf tmp',
    });
    assert.deepEqual(classifyToolCall('bash', { command: 'curl https://example.com' }), { kind: 'read-only' });
    assert.equal(classifyToolCall('bash', { command: 'curl https://example.com' }, 'drafting').kind, 'unsafe-command');
    assert.deepEqual(classifyToolCall('bash', {}), {
      kind: 'unsafe-command',
      reason: { kind: 'unparsable' },
      command: undefined,
    });
  });

  test('leaves read tools and custom tools outside the policy', () => {
    for (const toolName of ['read', 'grep', 'find', 'ls', 'custom_deploy', 'undo_last_replace']) {
      assert.deepEqual(classifyToolCall(toolName, { path: 'src/app.ts' }), { kind: 'read-only' }, toolName);
    }
  });
});
