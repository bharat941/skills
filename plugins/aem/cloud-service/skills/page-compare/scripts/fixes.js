#!/usr/bin/env node
'use strict';

// Prints part of a run's fixes.json, so an agent can work on one slice of a large run at a time.

const { parseArgs } = require('util');
const path = require('path');
const { loadBaseline, filterFixes } = require('./lib/fixes');

const USAGE = `Usage: node fixes.js <out-dir> [options]

Prints the fixes of an earlier run (its fixes.json) that match all given filters, as JSON.

  --priority <list>   P1, P2, P3, expected (comma-separated)
  --area <list>       content, visual, integration
  --type <list>       fix type: content, code, config
  --id <list>         fix ids
  --page <text>       only pages whose source or destination URL contains this text
  -h, --help`;

function main() {
  let opts;
  try {
    opts = parseArgs({
      allowPositionals: true,
      options: {
        priority: { type: 'string' }, area: { type: 'string' }, type: { type: 'string' }, id: { type: 'string' }, page: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    return usage(e.message);
  }
  if (opts.values.help) return console.log(USAGE);
  const dir = opts.positionals[0];
  if (!dir) return usage('Give the --out folder of an earlier run.');
  const list = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);
  try {
    const data = loadBaseline(path.resolve(dir));
    const out = filterFixes(data, { priority: list(opts.values.priority), area: list(opts.values.area), type: list(opts.values.type), id: list(opts.values.id), page: opts.values.page || '' });
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } catch (e) {
    usage(e.message.replace(/^--baseline: /, ''));
  }
}

function usage(msg) {
  console.error(`${msg}\n\n${USAGE}`);
  process.exitCode = 2;
}

main();
