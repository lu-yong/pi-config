export interface StateEntry {
  type: string;
  customType?: string;
  data?: unknown;
}

export type ContextMessage = object & {
  customType?: string;
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

const FILE_MUTATION_REASON =
  'Read-only mode: file modifications are not allowed. Use /readonly to exit read-only mode first.';

const SAFE_COMMANDS = new Set([
  'apropos',
  'arch',
  'basename',
  'bat',
  'bzcat',
  'cal',
  'cat',
  'cmp',
  'comm',
  'cut',
  'date',
  'df',
  'dir',
  'dirname',
  'dog',
  'du',
  'echo',
  'egrep',
  'env',
  'fd',
  'fgrep',
  'file',
  'fold',
  'free',
  'grep',
  'groups',
  'head',
  'hexdump',
  'help',
  'host',
  'hostname',
  'htop',
  'id',
  'info',
  'jobs',
  'jq',
  'less',
  'locate',
  'lsof',
  'man',
  'mlocate',
  'more',
  'nl',
  'nslookup',
  'od',
  'ping',
  'printenv',
  'printf',
  'ps',
  'pt',
  'pwd',
  'readlink',
  'realpath',
  'rg',
  'ripgrep',
  'sdiff',
  'sort',
  'stat',
  'strings',
  'tail',
  'tldr',
  'top',
  'traceroute',
  'tree',
  'type',
  'uname',
  'uniq',
  'uptime',
  'wc',
  'whatis',
  'whereis',
  'which',
  'whoami',
  'whois',
  'xxd',
  'xzcat',
  'yq',
  'zcat',
  'zdiff',
  'zgrep',
  'zless',
  'zmore',
]);

const READ_ONLY_GIT_COMMANDS = new Set([
  'blame',
  'describe',
  'diff',
  'for-each-ref',
  'grep',
  'log',
  'ls-files',
  'ls-remote',
  'ls-tree',
  'merge-base',
  'name-rev',
  'rev-list',
  'rev-parse',
  'shortlog',
  'show',
  'show-ref',
  'status',
]);

const APPROVED_SCRIPT = /^(test|lint|typecheck|type-check|check)(:[A-Za-z0-9_.-]+)?$|^format:check$/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

const READONLY_INSTRUCTIONS = `[READ-ONLY MODE ACTIVE]
You are in local read-only mode for exploration, planning, code review, and architecture analysis.

Enforced core-tool restrictions:
- Pi's built-in edit and write tools are blocked.
- Bash commands are fail-closed. Approved read commands, tests, and static checks are allowed; installs, builds, publishing, arbitrary scripts, redirection, background execution, and command substitution are blocked.
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
            message: 'Read-only mode ON - edit/write blocked, bash restricted to approved commands',
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

    if (toolName === 'edit' || toolName === 'write') {
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

function isSafeShellCommand(command: string): boolean {
  const commands = parseCompoundCommand(command);
  return commands !== undefined && commands.every(isSafeArgv);
}

function parseCompoundCommand(command: string): string[][] | undefined {
  if (!command.trim()) return undefined;

  const commands: string[][] = [];
  let argv: string[] = [];
  let token = '';
  let tokenStarted = false;
  let quote: 'single' | 'double' | undefined;

  const pushToken = () => {
    if (!tokenStarted) return;
    argv.push(token);
    token = '';
    tokenStarted = false;
  };
  const pushCommand = () => {
    pushToken();
    if (argv.length === 0) return false;
    commands.push(argv);
    argv = [];
    return true;
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1];

    if (quote === 'single') {
      if (char === "'") quote = undefined;
      else token += char;
      tokenStarted = true;
      continue;
    }

    if (quote === 'double') {
      if (char === '"') {
        quote = undefined;
      } else if (char === '`' || (char === '$' && next === '(')) {
        return undefined;
      } else if (char === '\\') {
        if (next === undefined) return undefined;
        token += next;
        tokenStarted = true;
        index += 1;
      } else {
        token += char;
        tokenStarted = true;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char === "'" ? 'single' : 'double';
      tokenStarted = true;
      continue;
    }
    if (char === '\\') {
      if (next === undefined) return undefined;
      token += next;
      tokenStarted = true;
      index += 1;
      continue;
    }
    if (char === '`' || (char === '$' && next === '(')) return undefined;
    if (char === '<' || char === '>' || char === '(' || char === ')') return undefined;

    if (char === '&') {
      if (next !== '&' || !pushCommand()) return undefined;
      index += 1;
      continue;
    }
    if (char === '|') {
      if (!pushCommand()) return undefined;
      if (next === '|') index += 1;
      continue;
    }
    if (char === ';' || char === '\n') {
      if (!pushCommand()) return undefined;
      continue;
    }
    if (/\s/.test(char)) {
      pushToken();
      continue;
    }

    token += char;
    tokenStarted = true;
  }

  if (quote || !pushCommand()) return undefined;
  return commands;
}

function isSafeArgv(originalArgv: string[]): boolean {
  let argv = [...originalArgv];
  let leadingAssignments = 0;
  while (argv[0] && ASSIGNMENT.test(argv[0])) {
    leadingAssignments += 1;
    argv = argv.slice(1);
  }
  if (argv.length === 0) return true;
  if (!isTrustedCommandPath(argv[0])) return false;

  const command = basename(argv[0]);
  const args = argv.slice(1);
  if (leadingAssignments > 0 && command !== 'env') return false;

  if (command === 'cd') return args.every((arg) => !arg.startsWith('-') || /^-[LP]$/.test(arg));
  if (command === 'env') return isSafeEnv(args, leadingAssignments > 0);
  if (command === 'command') {
    if (args[0] === '-v' || args[0] === '-V') return args.length > 1;
    return args.length > 0 && isSafeArgv(args);
  }
  if (command === 'time') {
    const nested = args[0] === '-p' ? args.slice(1) : args;
    return nested.length > 0 && isSafeArgv(nested);
  }
  if (command === 'timeout') {
    const nestedIndex = args.findIndex((arg) => !arg.startsWith('-') && /^\d+(\.\d+)?[smhd]?$/.test(arg));
    return nestedIndex >= 0 && isSafeArgv(args.slice(nestedIndex + 1));
  }

  if (command === 'git') return isSafeGit(args);
  if (command === 'curl') return isSafeCurl(args);
  if (command === 'wget') return isSafeWget(args);
  if (command === 'find') return isSafeFind(args);
  if (command === 'npm' || command === 'pnpm' || command === 'yarn') {
    return isSafePackageCommand(command, args);
  }
  if (command === 'bun') return isSafeBun(args);
  if (command === 'cargo') return isSafeCargo(args);
  if (command === 'go') return isSafeGo(args);
  if (command === 'swift') return isSafeSwift(args);
  if (command === 'pytest' || command === 'vitest' || command === 'jest') return true;
  if (command === 'eslint') return !args.includes('--fix');
  if (command === 'tsc') {
    return (
      args.includes('--noEmit') ||
      args.includes('--showConfig') ||
      args.includes('--version') ||
      args.includes('--help')
    );
  }

  if (!SAFE_COMMANDS.has(command)) return false;
  if (command === 'diff' && hasOption(args, '--output', true)) return false;
  if (command === 'sort' && (hasOption(args, '--output', true) || args.some((arg) => /^-o/.test(arg)))) return false;
  if (command === 'uniq' && positionalArgs(args).length > 1) return false;
  if (command === 'xxd' && args.some((arg) => arg === '-r' || arg.startsWith('-r'))) return false;
  if (command === 'yq' && args.some((arg) => arg === '-i' || arg === '--in-place')) return false;
  return true;
}

function isSafeEnv(args: string[], inheritedAssignment: boolean): boolean {
  let index = 0;
  let hasAssignment = inheritedAssignment;
  while (index < args.length) {
    const arg = args[index];
    if (ASSIGNMENT.test(arg)) {
      hasAssignment = true;
      index += 1;
      continue;
    }
    if (['-i', '--ignore-environment', '-0', '--null'].includes(arg)) {
      index += 1;
      continue;
    }
    if ((arg === '-u' || arg === '--unset' || arg === '-C' || arg === '--chdir') && args[index + 1]) {
      index += 2;
      continue;
    }
    if (/^(--unset|--chdir)=/.test(arg) || /^-u.+/.test(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) return false;
    return !hasAssignment && isSafeArgv(args.slice(index));
  }
  return true;
}

function isSafeGit(args: string[]): boolean {
  let index = 0;
  while (index < args.length && args[index].startsWith('-')) {
    const option = args[index];
    if (option === '--version' || option === '--help') return index === args.length - 1;
    if (option === '--no-pager' || option === '--paginate') {
      index += 1;
      continue;
    }
    if (option === '-C' && args[index + 1]) {
      index += 2;
      continue;
    }
    return false;
  }

  const subcommand = args[index];
  const subArgs = args.slice(index + 1);
  if (!subcommand) return false;
  if (subArgs.some((arg) => arg === '--output' || arg.startsWith('--output='))) return false;
  if (subArgs.some((arg) => arg.startsWith('--open-files-in-pager'))) return false;
  if (READ_ONLY_GIT_COMMANDS.has(subcommand)) return true;

  switch (subcommand) {
    case 'branch':
      return isSafeGitBranch(subArgs);
    case 'config':
      if (subArgs.some((arg) =>
        /^(--add|--replace-all|--unset|--unset-all|--rename-section|--remove-section|--edit|-e)$/.test(arg),
      )) return false;
      return subArgs.some((arg) =>
        /^(--get|--get-all|--get-regexp|--get-urlmatch|--list|-l|--show-origin|--show-names|--show-scope)$/.test(arg),
      );
    case 'remote':
      if (subArgs.some((arg) =>
        /^(add|remove|rename|set-branches|set-head|set-url|update|prune)$/.test(arg),
      )) return false;
      return subArgs.length === 0 || ['-v', '--verbose', 'show', 'get-url'].includes(subArgs[0]);
    case 'stash':
      return subArgs[0] === 'list' || subArgs[0] === 'show';
    case 'submodule':
      return subArgs[0] === 'status' || subArgs[0] === 'summary';
    case 'tag':
      return subArgs.length === 0 || subArgs[0] === '--list' || subArgs[0] === '-l';
    case 'worktree':
      return subArgs[0] === 'list';
    case 'reflog':
      return subArgs.length === 0 || subArgs[0] === 'show';
    default:
      return false;
  }
}

function isSafeGitBranch(args: string[]): boolean {
  if (args.length === 0) return true;
  const optionsWithValues = new Set(['--contains', '--no-contains', '--merged', '--no-merged', '--points-at']);
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (['--list', '-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose', '--no-color'].includes(arg)) {
      index += 1;
      continue;
    }
    if (optionsWithValues.has(arg) && args[index + 1]) {
      index += 2;
      continue;
    }
    if (args[0] === '--list' && !arg.startsWith('-')) {
      index += 1;
      continue;
    }
    return false;
  }
  return true;
}

function isSafeCurl(args: string[]): boolean {
  if (args.length === 0) return false;

  const blockedLong = [
    '--alt-svc', '--config', '--cookie-jar', '--data', '--data-ascii', '--data-binary',
    '--data-raw', '--data-urlencode', '--dump-header', '--etag-save', '--form', '--form-string',
    '--hsts', '--output', '--output-dir', '--remote-header-name', '--remote-name',
    '--remote-name-all', '--remove-on-error', '--trace', '--trace-ascii', '--trace-config',
    '--trace-time', '--upload-file',
  ];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (blockedLong.some((option) => arg === option || arg.startsWith(`${option}=`))) return false;
    if (arg === '--json' || arg.startsWith('--json=')) return false;
    if (arg === '--stderr' || arg.startsWith('--stderr=')) return false;
    if (arg === '-X' || arg === '--request') {
      const method = args[index + 1]?.toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') return false;
      index += 1;
      continue;
    }
    if (arg.startsWith('-X') && !/^\-X(GET|HEAD)$/i.test(arg)) return false;
    if (arg.startsWith('--request=') && !/^--request=(GET|HEAD)$/i.test(arg)) return false;
    if (/^-[^-]*[oOTdFKcD]/.test(arg)) return false;
  }
  return true;
}

function isSafeWget(args: string[]): boolean {
  if (args.length === 0) return false;
  const writesStdout = args.some(
    (arg) => arg === '-O-' || arg === '--output-document=-' || /^-[^-]*O-$/.test(arg),
  );
  const spider = args.includes('--spider');
  if (!writesStdout && !spider) return false;
  return !args.some((arg) =>
    /^(--output-file|--append-output|--config|--directory-prefix|--warc-file)(=|$)/.test(arg) ||
    (/^-[^-]*[oaP]/.test(arg) && !/^-[^-]*O-$/.test(arg)),
  );
}

function isSafeFind(args: string[]): boolean {
  const mutating = new Set([
    '-delete', '-exec', '-execdir', '-fls', '-fprint', '-fprint0', '-fprintf', '-ok', '-okdir',
  ]);
  return !args.some((arg) => mutating.has(arg));
}

function isSafePackageCommand(command: string, args: string[]): boolean {
  const subcommand = args[0];
  if (!subcommand) return false;
  if (['list', 'ls', 'view', 'info', 'show', 'search', 'outdated', 'audit', 'why'].includes(subcommand)) {
    return !args.some((arg) => arg === '--fix' || arg.startsWith('--fix='));
  }
  if (subcommand === 'test' || subcommand === 't') return true;
  if (subcommand === 'run' || subcommand === 'run-script') return APPROVED_SCRIPT.test(args[1] ?? '');
  if ((command === 'pnpm' || command === 'yarn') && APPROVED_SCRIPT.test(subcommand)) return true;
  return false;
}

function isSafeBun(args: string[]): boolean {
  if (args[0] === 'test') return true;
  return args[0] === 'run' && APPROVED_SCRIPT.test(args[1] ?? '');
}

function isSafeCargo(args: string[]): boolean {
  if (args.includes('--fix')) return false;
  if (['test', 'check', 'clippy', 'metadata', 'tree', 'search'].includes(args[0])) return true;
  return args[0] === 'fmt' && args.includes('--check');
}

function isSafeGo(args: string[]): boolean {
  return ['test', 'vet', 'list', 'env', 'version', 'doc'].includes(args[0]);
}

function isSafeSwift(args: string[]): boolean {
  if (args[0] === '--version' || args[0] === '-version' || args[0] === 'test') return true;
  return args[0] === 'package' && ['describe', 'dump-package', 'show-dependencies'].includes(args[1]);
}

function hasOption(args: string[], option: string, allowEquals: boolean): boolean {
  return args.some((arg) => arg === option || (allowEquals && arg.startsWith(`${option}=`)));
}

function positionalArgs(args: string[]): string[] {
  return args.filter((arg) => !arg.startsWith('-'));
}

function isTrustedCommandPath(command: string): boolean {
  if (!command.includes('/')) return true;
  return ['/bin/', '/usr/bin/', '/usr/sbin/', '/sbin/'].some((prefix) => command.startsWith(prefix));
}

function basename(command: string): string {
  return command.slice(command.lastIndexOf('/') + 1);
}
