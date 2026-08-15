/**
 * Read-only command policy: the single classifier deciding whether a bash
 * command may run without mutating the local workspace.
 *
 * Shared by readonly-mode enforcement and the planning-files-runtime goal
 * drafting guard. Profiles are subtractive: 'standard' is the full read-only
 * surface; 'drafting' additionally forbids network commands. Anything the
 * parser cannot classify is unsafe (fail-closed), and every segment of a
 * pipeline or compound command is checked independently.
 */

export type CommandProfile = 'standard' | 'drafting';

/**
 * Why a command was rejected: 'unparsable' when the tokenizer could not reduce
 * it to plain command segments (fail-closed), 'segment' when a specific segment
 * is not an approved read-only command.
 */
export type UnsafeCommandReason =
  | { kind: 'unparsable' }
  | { kind: 'segment'; segment: string };

/**
 * Commands the 'drafting' profile additionally forbids. Exported so callers
 * that describe the policy to the model (rejection messages, prompts) can
 * derive the list instead of hand-copying it.
 */
export const NETWORK_COMMANDS: ReadonlySet<string> = Object.freeze(new Set([
  'curl',
  'host',
  'nslookup',
  'ping',
  'traceroute',
  'wget',
  'whois',
]));

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
  'diff',
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
  'ls',
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

/**
 * Otherwise read-only commands that grow a write vector via an output-file
 * option (-o FILE / --output=FILE). None of them has an unrelated flag starting
 * with -o, so the whole -o prefix can be rejected.
 */
const OUTPUT_FILE_COMMANDS = new Set(['diff', 'sdiff', 'sort']);

export function isSafeShellCommand(command: string, profile: CommandProfile = 'standard'): boolean {
  return explainUnsafeCommand(command, profile) === undefined;
}

/**
 * Same classification as isSafeShellCommand, but names why the command was
 * rejected so callers can tell the user which part failed. Returns undefined
 * when the command is safe. `segment` is the normalized (quote-stripped) argv
 * of the first rejected segment, not a verbatim slice of the input.
 */
export function explainUnsafeCommand(
  command: string,
  profile: CommandProfile = 'standard',
): UnsafeCommandReason | undefined {
  const commands = parseCompoundCommand(command);
  if (commands === undefined) return { kind: 'unparsable' };
  const rejected = commands.find((argv) => !isSafeArgv(argv, profile));
  if (!rejected) return undefined;
  return { kind: 'segment', segment: rejected.join(' ') };
}

function parseCompoundCommand(command: string): string[][] | undefined {
  if (!command.trim()) return undefined;

  const commands: string[][] = [];
  let argv: string[] = [];
  let token = '';
  let tokenStarted = false;
  let tokenIsBare = true;
  let quote: 'single' | 'double' | undefined;

  const pushToken = () => {
    if (!tokenStarted) return;
    argv.push(token);
    token = '';
    tokenStarted = false;
    tokenIsBare = true;
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
      tokenIsBare = false;
      quote = char === "'" ? 'single' : 'double';
      tokenStarted = true;
      continue;
    }
    if (char === '\\') {
      if (next === undefined) return undefined;
      tokenIsBare = false;
      token += next;
      tokenStarted = true;
      index += 1;
      continue;
    }
    if (char === '`' || (char === '$' && next === '(')) return undefined;
    if (char === '>' && tokenIsBare && token === '2' && command.startsWith('>/dev/null', index)) {
      const afterRedirect = command[index + '>/dev/null'.length];
      if (afterRedirect === undefined || /\s/.test(afterRedirect) || ['&', '|', ';'].includes(afterRedirect)) {
        // Only a bare shell IO number may use this harmless redirection form.
        token = '';
        tokenStarted = false;
        tokenIsBare = true;
        index += '>/dev/null'.length - 1;
        continue;
      }
    }
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

function isSafeArgv(originalArgv: string[], profile: CommandProfile): boolean {
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
  if (profile === 'drafting' && NETWORK_COMMANDS.has(command)) return false;

  if (command === 'cd') return args.every((arg) => !arg.startsWith('-') || /^-[LP]$/.test(arg));
  if (command === 'env') return isSafeEnv(args, leadingAssignments > 0, profile);
  if (command === 'command') {
    if (args[0] === '-v' || args[0] === '-V') return args.length > 1;
    return args.length > 0 && isSafeArgv(args, profile);
  }
  if (command === 'time') {
    const nested = args[0] === '-p' ? args.slice(1) : args;
    return nested.length > 0 && isSafeArgv(nested, profile);
  }
  if (command === 'timeout') {
    const nestedIndex = args.findIndex((arg) => !arg.startsWith('-') && /^\d+(\.\d+)?[smhd]?$/.test(arg));
    return nestedIndex >= 0 && isSafeArgv(args.slice(nestedIndex + 1), profile);
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
  if (OUTPUT_FILE_COMMANDS.has(command) && writesToOutputFile(args)) return false;
  if (command === 'uniq' && positionalArgs(args).length > 1) return false;
  if (command === 'xxd' && args.some((arg) => arg === '-r' || arg.startsWith('-r'))) return false;
  if (command === 'yq' && args.some((arg) => arg === '-i' || arg === '--in-place')) return false;
  return true;
}

function isSafeEnv(args: string[], inheritedAssignment: boolean, profile: CommandProfile): boolean {
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
    return !hasAssignment && isSafeArgv(args.slice(index), profile);
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

function writesToOutputFile(args: string[]): boolean {
  return hasOption(args, '--output', true) || args.some((arg) => /^-o/.test(arg));
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
