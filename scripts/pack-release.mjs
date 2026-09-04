#!/usr/bin/env node
// Build the release zip the Lab accepts, out of this repository alone.
//
//   node scripts/pack-release.mjs                  # dist/<id>-<version>.zip
//   node scripts/pack-release.mjs --out build      # somewhere else
//   node scripts/pack-release.mjs --expect 0.5.0   # release mode: see below
//
// Unlike scripts/release.mjs this needs no SoundBase checkout. The zip's
// dependencies are the ones already installed here, so run an install first
// and prune the dev ones:
//
//   npm ci && npm prune --omit=dev
//
// That works because both SDK packages are on public npm. `.github/workflows/
// release.yml` does exactly this on a tag push; nothing stops you running the
// same three commands by hand.
//
// It packs, boots the packed result the way the installer's probe does, and
// checks it against the Lab's rules before you find out from a rejection:
//
//   - one top-level folder, no path traversal
//   - soundbase-plugin.json, LICENSE, main.js and package.json at its root
//   - the manifest valid-looking, `license` set, id and version as expected
//   - at most 250 MB
//
// `--expect <x.y.z>` turns the warnings into refusals: it is the mode CI runs
// in, where nobody is reading stdout. It requires that version in BOTH
// soundbase-plugin.json and package.json, and refuses a plugin still called
// "template" — releasing under the template's id namespaces every deviceTypeId
// you ship as `plugin:template/…` and stores that in users' projects.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ASSET_MAX_BYTES = 250 * 1024 * 1024;

// Repository files that are not part of the running plugin. The zip is a
// drop-in folder, not a checkout: no tests, no docs, no CI, no scripts, and
// not the example plugin either — it is reference material for you, and
// shipping it puts a second manifest and a second test suite in every user's
// install. package.json is in the list because it is written, not copied.
//
// Kept identical to the list in release.mjs; see the note there.
const NOT_SHIPPED = [
  '.github',
  '.gitignore',
  '__tests__',
  'CLAUDE.md',
  'docs',
  'examples',
  'package-lock.json',
  'package.json',
  'scripts',
];

const log = (msg) => process.stdout.write(`[pack-release] ${msg}\n`);
const warn = (msg) => process.stdout.write(`[pack-release] WARNING: ${msg}\n`);
const fail = (msg) => {
  process.stderr.write(`[pack-release] ERROR: ${msg}\n`);
  process.exit(1);
};

// -- args --------------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const expected = flag('--expect');
const releasing = expected !== null;
if (releasing && !/^\d+\.\d+\.\d+$/.test(expected)) {
  fail(`--expect wants a version like 0.5.0, got "${expected}"`);
}
const outDir = resolve(ROOT, flag('--out') ?? 'dist');

// In release mode a problem must stop the build; run by hand it should say so
// and carry on, because seeing the zip is the point of running it by hand.
const refuse = releasing ? fail : warn;

const run = (cmd, cmdArgs, { cwd = ROOT } = {}) => {
  log(`$ ${[cmd, ...cmdArgs].join(' ')}`);
  const r = spawnSync(cmd, cmdArgs, { cwd, stdio: 'inherit' });
  if (r.error || r.status !== 0) fail(`${cmd} ${cmdArgs[0]} failed`);
};
const capture = (cmd, cmdArgs, { cwd = ROOT } = {}) => {
  const r = spawnSync(cmd, cmdArgs, { cwd, encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    fail(`${cmd} ${cmdArgs.join(' ')} failed: ${r.stderr?.trim() || r.error}`);
  }
  return r.stdout.trim();
};
const git = (...gitArgs) => {
  const r = spawnSync('git', gitArgs, { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
};

// -- what is being packed ----------------------------------------------------

const manifest = JSON.parse(
  readFileSync(join(ROOT, 'soundbase-plugin.json'), 'utf8')
);
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const id = manifest.id;
const version = manifest.version;

if (pkg.version !== version) {
  fail(
    `soundbase-plugin.json says ${version} and package.json says ${pkg.version}` +
      ' — the two versions ship together and the Lab reads the manifest'
  );
}
if (releasing && version !== expected) {
  fail(
    `expected ${expected} but this tree is ${version}; the tag and the ` +
      'manifest have to agree, or users install a version nobody released'
  );
}
if (id === 'template') {
  refuse(
    'the plugin id is still "template" — run `npm run rename <your-id>` ' +
      'before releasing; the id is stored in every user project that uses it'
  );
}
if (!manifest.license) {
  refuse('soundbase-plugin.json declares no `license`; the Lab requires one');
}

// Dependencies are whatever is installed here, so an empty or dev-heavy
// node_modules produces a zip that cannot boot on a user's machine.
const installed = (name) => {
  const p = join(ROOT, 'node_modules', name, 'package.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')).version : null;
};
for (const name of ['@soundbase/plugin-contract', '@soundbase/plugin-shell']) {
  if (!installed(name)) {
    fail(
      `${name} is not installed — nothing installs dependencies on the user's ` +
        'machine, so they have to be in the zip: npm ci && npm prune --omit=dev'
    );
  }
}

// -- assemble ----------------------------------------------------------------

const packName = `${id}-pack`;
const tmp = mkdtempSync(join(tmpdir(), `${id}-release-`));
const packDir = join(tmp, packName);
mkdirSync(packDir);

// git decides what ships: a file nobody committed is not part of the release,
// and this is also what keeps build leftovers and local scratch files out.
const tracked = git('ls-files');
if (tracked === null) fail('not a git repository, or git is unavailable');
const shipped = tracked
  .split('\n')
  .filter(
    (f) => f && !NOT_SHIPPED.some((n) => f === n || f.startsWith(`${n}/`))
  );
for (const f of shipped) {
  mkdirSync(dirname(join(packDir, f)), { recursive: true });
  copyFileSync(join(ROOT, f), join(packDir, f));
}
log(`${shipped.length} tracked files: ${shipped.join(', ')}`);

// `.bin` holds symlinks to executables a drop-in plugin folder never runs, and
// symlinks in a zip are a portability problem for no benefit.
cpSync(join(ROOT, 'node_modules'), join(packDir, 'node_modules'), {
  recursive: true,
  filter: (src) => !src.split(sep).includes('.bin'),
});

// -- package.json ------------------------------------------------------------
//
// Written rather than copied, and deliberately close to what
// SoundBase's own pack-plugin.mjs writes, so a zip cut here and a zip cut in
// the monorepo describe themselves the same way.

const packed = { ...pkg };
// `test` needs the __tests__ that were just left out and the rest name scripts
// that do not travel — a drop-in folder is only ever started.
packed.scripts = pkg.scripts?.start ? { start: pkg.scripts.start } : undefined;
delete packed.devDependencies;

const bundled = [];
for (const name of Object.keys(packed.dependencies ?? {})) {
  if (!name.startsWith('@soundbase/')) continue;
  // the vendored version, not the range: this is what is actually in the zip
  packed.dependencies[name] = installed(name);
  bundled.push(name);
}
if (bundled.length) packed.bundleDependencies = bundled.sort();

// The artifact's identity. Version fields are hand-maintained and therefore
// lie; this moves whenever the shipped content moves and not otherwise, so two
// downloads with the same hash are the same plugin whatever they were called.
// node_modules is excluded (already pinned above) and so is package.json,
// which is where the hash lands.
const contentHash = () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(relative(packDir, full));
    }
  };
  walk(packDir);
  const hash = createHash('sha256');
  const ordered = files
    .filter((f) => f !== 'package.json')
    // POSIX separators, so a Windows-built zip hashes to the same value
    .map((f) => f.split(sep).join('/'))
    .sort();
  for (const rel of ordered) {
    hash.update(rel);
    hash.update('\0');
    hash.update(readFileSync(join(packDir, rel.split('/').join(sep))));
  }
  return `sha256:${hash.digest('hex').slice(0, 16)}`;
};

const commit = git('rev-parse', 'HEAD');
packed.soundbase = {
  ...pkg.soundbase,
  packedFrom: `${pkg.name}@${version}`,
  contentHash: contentHash(),
  packedAt: new Date().toISOString(),
  contract: manifest.contract,
  contractPackageVersion: installed('@soundbase/plugin-contract'),
  shellVersion: installed('@soundbase/plugin-shell'),
  // --untracked-files=no on purpose: the zip's contents come from
  // `git ls-files`, so an untracked file cannot be in it. What would make this
  // zip disagree with `commit` is an edit to a file that IS tracked. Counting
  // untracked files would call every release dirty, because `npm install`
  // writes a package-lock.json that authors have not necessarily committed.
  ...(commit
    ? {
        commit,
        dirty: git('status', '--porcelain', '--untracked-files=no') !== '',
      }
    : {}),
};
writeFileSync(
  join(packDir, 'package.json'),
  `${JSON.stringify(packed, null, 2)}\n`
);
if (packed.soundbase.dirty) {
  refuse('packed from a tree with uncommitted changes');
}

// -- boot it -----------------------------------------------------------------
//
// The installer spawns the plugin and waits for the handshake before it
// installs anything. Finding out here costs seconds; finding out from a user
// costs a release.

mkdirSync(join(packDir, 'scripts'));
copyFileSync(
  join(ROOT, 'scripts', 'smoke.mjs'),
  join(packDir, 'scripts', 'smoke.mjs')
);
run('node', [join('scripts', 'smoke.mjs')], { cwd: packDir });
rmSync(join(packDir, 'scripts'), { recursive: true });

// -- zip ---------------------------------------------------------------------

const zipPath = join(outDir, `${id}-${version}.zip`);
mkdirSync(outDir, { recursive: true });
rmSync(zipPath, { force: true });
run('zip', ['-qr', zipPath, packName], { cwd: tmp });
rmSync(tmp, { recursive: true, force: true });

// -- check it against the Lab's rules ----------------------------------------

const entries = capture('unzip', ['-Z1', zipPath]).split('\n');
const prefix = `${packName}/`;
const stray = entries.find((e) => !e.startsWith(prefix) || e.includes('..'));
if (stray) fail(`unexpected zip entry: ${stray}`);
for (const f of [
  'soundbase-plugin.json',
  'LICENSE',
  'main.js',
  'package.json',
]) {
  if (!entries.includes(prefix + f)) fail(`the zip has no ${f} at its root`);
}
const zipped = JSON.parse(
  capture('unzip', ['-p', zipPath, `${prefix}soundbase-plugin.json`])
);
if (zipped.id !== id || zipped.version !== version) {
  fail(
    `the zip's manifest says ${zipped.id} ${zipped.version}, expected ${id} ${version}`
  );
}
const bytes = statSync(zipPath).size;
if (bytes > ASSET_MAX_BYTES) {
  fail(`the zip is ${bytes} bytes; the Lab caps a release asset at 250 MB`);
}

log(
  `${relative(ROOT, zipPath)} — ${id} ${version}, ${entries.length} entries, ` +
    `${(bytes / 1024 / 1024).toFixed(1)} MB`
);
log(`identity — ${packed.soundbase.contentHash}`);
if (!releasing) {
  log(
    'not a release: attach this to a GitHub Release yourself, or push a v' +
      `${version} tag and let .github/workflows/release.yml do it`
  );
}
