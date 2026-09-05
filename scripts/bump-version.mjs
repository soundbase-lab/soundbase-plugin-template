#!/usr/bin/env node
// Move the plugin's version, everywhere it is written.
//
//   node scripts/bump-version.mjs patch        0.1.2 -> 0.1.3
//   node scripts/bump-version.mjs minor        0.1.2 -> 0.2.0
//   node scripts/bump-version.mjs major        0.1.2 -> 1.0.0
//   node scripts/bump-version.mjs 0.2.0        exactly that
//
// The version lives in three files that have to agree — soundbase-plugin.json
// (what the Lab and the host read), package.json and package-lock.json (what
// npm reads, and what `npm run doctor` checks against the manifest). The
// release workflow refuses a tag whose version differs from the manifest, so
// a bump that touches one file and not another is a failed release later.
//
// Prints the new version on stdout and nothing else, so a script can read it.
// Makes no commit and no tag: that is the release workflow's job, or yours.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const arg = process.argv[2];
const usage =
  'usage: bump-version.mjs <patch|minor|major|x.y.z>  (run from the plugin directory)';

if (!arg || !/^(patch|minor|major|\d+\.\d+\.\d+)$/.test(arg)) {
  process.stderr.write(`${usage}\n`);
  process.exit(2);
}

const read = (name) => JSON.parse(readFileSync(join(ROOT, name), 'utf8'));
const before = read('package.json').version;

// npm knows how to bump, and it keeps package-lock.json's root entry in step,
// which a hand edit of package.json would not.
execFileSync('npm', ['version', arg, '--no-git-tag-version'], {
  cwd: ROOT,
  stdio: ['ignore', 'ignore', 'inherit'],
});
const version = read('package.json').version;

// the manifest is edited in place as text so its formatting survives
const manifestPath = join(ROOT, 'soundbase-plugin.json');
const manifest = readFileSync(manifestPath, 'utf8');
const updated = manifest.replace(
  /^(\s*"version":\s*)"[^"]*"/m,
  `$1"${version}"`
);
if (updated === manifest && read('soundbase-plugin.json').version !== version) {
  process.stderr.write('soundbase-plugin.json has no top-level "version" line to update\n');
  process.exit(1);
}
writeFileSync(manifestPath, updated);

const check = read('soundbase-plugin.json').version;
if (check !== version) {
  process.stderr.write(`manifest says ${check} after writing ${version}\n`);
  process.exit(1);
}
process.stderr.write(`${before} -> ${version} in package.json, package-lock.json, soundbase-plugin.json\n`);
process.stdout.write(`${version}\n`);
