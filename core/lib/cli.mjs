import { parseArgs } from 'node:util';
import { EXIT, RelayError } from './exit.mjs';

// Parse argv with common flags (--json, --dry-run, --help). `options` follow node:util parseArgs.
export function parse(argv, options = {}, extra = {}) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      json: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      ...options,
    },
    ...extra,
  });
  return { flags: values, args: positionals };
}

export function out(flags, obj, text) {
  if (flags.json) process.stdout.write(JSON.stringify(obj) + '\n');
  else process.stdout.write((typeof text === 'string' ? text : JSON.stringify(obj, null, 2)) + '\n');
}

// Wrap a script main so RelayError maps to its exit code and stderr message.
export async function run(main) {
  try {
    const code = await main();
    process.exitCode = typeof code === 'number' ? code : EXIT.OK;
  } catch (e) {
    if (e instanceof RelayError) {
      process.stderr.write(`${e.message}\n`);
      process.exitCode = e.code;
    } else if (e && e.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || e?.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
      process.stderr.write(`${e.message}\n`);
      process.exitCode = EXIT.INVALID;
    } else {
      process.stderr.write(`${e?.stack || e}\n`);
      process.exitCode = EXIT.ERROR;
    }
  }
}
