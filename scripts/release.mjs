#!/usr/bin/env node
// cut a release the Lab can install: bump the version, commit + tag, pack the
// zip, push, and publish a GitHub Release with the zip as its only asset.
//
//   node scripts/release.mjs 0.5.0
//   node scripts/release.mjs 0.5.0 --notes "what changed"
//   node scripts/release.mjs --dry-run     # only build dist/<id>-<version>.zip from the tree as-is; git is untouched
//
// every command is echoed as `$ ...` so the steps can be repeated by hand.
//
// the zip comes from SoundBase's plugins/pack-plugin.mjs, so a SoundBase
// checkout with plugins/ and a completed `pnpm install` is needed: --sb
// <path>, SB_ROOT, or the first ~/CODE/SoundBase* that has one.
//
// that dependency is now historical rather than necessary: it dates from when
// @soundbase/plugin-shell and @soundbase/plugin-contract were not on npm and
// had to be vendored in from the monorepo. They are published now, and
// pack-release.mjs beside this file already builds the same zip from an
// ordinary `npm ci --omit=dev` with no checkout at all — it is what
// .github/workflows/release.yml runs. This script has simply not been moved
// over to it yet. If you have no SoundBase checkout, push a tag instead.
//
// what the Lab checks when the tag is submitted (labApi releaseResolver):
//   - a published (non-draft) GitHub Release on the tag
//   - exactly one .zip asset, at most 250 MB
//   - soundbase-plugin.json and a LICENSE file at the zip root (a single
//     top-level folder is fine), manifest valid, manifest.license set
//   - the tag's commit differs from the released one, and the manifest
//     version has never been released on this listing

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MANIFEST = join(ROOT, 'soundbase-plugin.json');
const PACKAGE = join(ROOT, 'package.json');
const ASSET_MAX_BYTES = 250 * 1024 * 1024;

// repo files that are not part of the running plugin. Kept identical to the
// list in pack-release.mjs — the two scripts build the same zip by different
// routes, and a zip whose contents depend on which one you ran is worse than
// either. A test in the SoundBase monorepo holds them together.
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

const log = (msg) => process.stdout.write(`[release] ${msg}\n`);
const fail = (msg) => {
  process.stderr.write(`[release] ERROR: ${msg}\n`);
  process.exit(1);
};

// -- args --------------------------------------------------------------------

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const requested = args[0] && !args[0].startsWith('--') ? args[0] : null;
if (!dryRun && !/^\d+\.\d+\.\d+$/.test(requested ?? '')) {
  fail(
    'usage: release.mjs <x.y.z> [--sb <soundbase checkout>] [--notes "text"] [--dry-run]'
  );
}

// -- shell helpers -----------------------------------------------------------

const quote = (s) => (/\s/.test(s) ? `"${s}"` : s);
const echo = (cmd, cmdArgs, cwd) =>
  log(
    `$ ${cwd === ROOT ? '' : `(cd ${cwd}) `}${[cmd, ...cmdArgs].map(quote).join(' ')}`
  );

// run and show the output; a non-zero exit aborts the release
const run = (cmd, cmdArgs, { cwd = ROOT } = {}) => {
  echo(cmd, cmdArgs, cwd);
  const r = spawnSync(cmd, cmdArgs, { cwd, stdio: 'inherit' });
  if (r.error || r.status !== 0) fail(`${cmd} ${cmdArgs[0]} failed`);
};

// run quietly and hand back stdout
const capture = (cmd, cmdArgs, { cwd = ROOT } = {}) => {
  const r = spawnSync(cmd, cmdArgs, { cwd, encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    fail(`${cmd} ${cmdArgs.join(' ')} failed: ${r.stderr?.trim() || r.error}`);
  }
  return r.stdout.trim();
};

// -- soundbase checkout ------------------------------------------------------

const hasPack = (dir) => existsSync(join(dir, 'plugins', 'pack-plugin.mjs'));
const findSoundbase = () => {
  const given = flag('--sb') ?? process.env.SB_ROOT;
  if (given) {
    if (!hasPack(given)) fail(`${given} has no plugins/pack-plugin.mjs`);
    return resolve(given);
  }
  const code = join(homedir(), 'CODE');
  const found = readdirSync(code)
    .filter((d) => d.startsWith('SoundBase'))
    .sort()
    .map((d) => join(code, d))
    .find(hasPack);
  if (!found) {
    fail(
      'no SoundBase checkout with plugins/pack-plugin.mjs under ~/CODE; pass --sb <path>'
    );
  }
  return found;
};

const SB = findSoundbase();
if (
  !existsSync(join(SB, 'plugins/template/node_modules/@soundbase/plugin-shell'))
) {
  fail(
    `${SB} is not installed; run there: pnpm install --filter "soundbase-plugin-template..."`
  );
}
log(`packing with ${SB}`);

// -- version -----------------------------------------------------------------

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const id = manifest.id;
const current = manifest.version;
const version = dryRun ? current : requested;
const tag = `v${version}`;
const packName = `${id}-pack`;
const zipPath = join(ROOT, 'dist', `${id}-${version}.zip`);

if (!dryRun) {
  // Releasing under the template's own id would namespace your deviceTypeIds
  // as `plugin:template/...` and store that in every user's project, where it
  // cannot be changed painlessly later. doctor and `npm run manifest` both
  // warn about it; a release is the point where a warning is too late.
  if (id === 'template') {
    fail(
      'the plugin id is still "template" — run `npm run rename <your-id>` first'
    );
  }

  // Cloning this template instead of using "Use this template" leaves origin
  // pointing at the upstream repository, so the tag and GitHub Release below
  // would target someone else's repo. That fails on permissions, but late and
  // confusingly, after the version bump has already been committed.
  // not capture(): that exits on a non-zero status, and a repository with no
  // `origin` at all would fail here with git's message instead of a useful one
  const originResult = spawnSync('git', ['remote', 'get-url', 'origin'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const origin = originResult.status === 0 ? originResult.stdout.trim() : '';
  if (/soundbase-plugin-template(\.git)?\/?$/.test(origin)) {
    fail(
      `origin is still the upstream template (${origin}).\n` +
        'Create your own repository with "Use this template" on the template\'s ' +
        'GitHub page, then point origin at it: git remote set-url origin <your repo>'
    );
  }

  if (version === current) fail(`${current} is already the current version`);
  if (capture('git', ['status', '--porcelain'])) {
    fail(
      'working tree is not clean; commit your changes first, the release commit carries only the version bump'
    );
  }
  const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== 'main') fail(`on ${branch}; releases are cut from main`);
  if (capture('git', ['tag', '-l', tag])) {
    fail(`tag ${tag} already exists locally: git tag -d ${tag}`);
  }
  if (capture('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`])) {
    fail(
      `tag ${tag} already exists on origin: git push origin --delete ${tag}`
    );
  }
  capture('gh', ['auth', 'status']);

  // the top-level key sits at two-space indent; nested "version"s are deeper
  const setVersion = (file) => {
    const after = readFileSync(file, 'utf8').replace(
      /^  "version": "[^"]+"/m,
      `  "version": "${version}"`
    );
    if (JSON.parse(after).version !== version) {
      fail(`could not set version in ${basename(file)}`);
    }
    writeFileSync(file, after);
    log(`${basename(file)}: ${current} -> ${version}`);
  };
  setVersion(MANIFEST);
  setVersion(PACKAGE);

  run('git', [
    'commit',
    '-m',
    tag,
    '--',
    'soundbase-plugin.json',
    'package.json',
  ]);
  run('git', ['tag', tag]);
}

// -- pack --------------------------------------------------------------------

const tmp = mkdtempSync(join(tmpdir(), `${id}-release-`));
const packDir = join(tmp, packName);

// the monorepo's template plugin plus vendored node_modules
run(
  'node',
  [join(SB, 'plugins/pack-plugin.mjs'), 'template', '--out', packDir],
  {
    cwd: SB,
  }
);

// this repo's own files go on top of the template's
const shipped = capture('git', ['ls-files'])
  .split('\n')
  .filter((f) => !NOT_SHIPPED.some((n) => f === n || f.startsWith(`${n}/`)));
for (const f of shipped) {
  mkdirSync(dirname(join(packDir, f)), { recursive: true });
  copyFileSync(join(ROOT, f), join(packDir, f));
}
log(`overlaid ${shipped.join(', ')}`);
rmSync(join(packDir, '.turbo'), { recursive: true, force: true });

// pack-plugin.mjs stamped the template; restate the stamp for what is shipped
const contentHash = (dir) => {
  const files = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile())
        files.push(relative(dir, full).split(sep).join('/'));
    }
  };
  walk(dir);
  const hash = createHash('sha256');
  for (const rel of files.filter((f) => f !== 'package.json').sort()) {
    hash.update(rel);
    hash.update('\0');
    hash.update(readFileSync(join(dir, rel)));
  }
  return `sha256:${hash.digest('hex').slice(0, 16)}`;
};
const packedPkgPath = join(packDir, 'package.json');
const packedPkg = JSON.parse(readFileSync(packedPkgPath, 'utf8'));
packedPkg.version = version;
packedPkg.soundbase = {
  ...packedPkg.soundbase,
  contentHash: contentHash(packDir),
  commit: capture('git', ['rev-parse', 'HEAD']),
  dirty: Boolean(capture('git', ['status', '--porcelain'])),
};
writeFileSync(packedPkgPath, `${JSON.stringify(packedPkg, null, 2)}\n`);

// boot the packed plugin the way the Desktop's install probe does
mkdirSync(join(packDir, 'scripts'));
copyFileSync(
  join(ROOT, 'scripts/smoke.mjs'),
  join(packDir, 'scripts/smoke.mjs')
);
run('node', ['scripts/smoke.mjs'], { cwd: packDir });
rmSync(join(packDir, 'scripts'), { recursive: true });

// one top-level folder inside the zip, like every release before
mkdirSync(dirname(zipPath), { recursive: true });
rmSync(zipPath, { force: true });
run('zip', ['-qr', zipPath, packName], { cwd: tmp });
rmSync(tmp, { recursive: true, force: true });

// -- verify the zip against the Lab's rules ----------------------------------

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
  if (!entries.includes(prefix + f)) fail(`zip has no ${f} at its root`);
}
const packed = JSON.parse(
  capture('unzip', ['-p', zipPath, `${prefix}soundbase-plugin.json`])
);
if (packed.id !== id || packed.version !== version) {
  fail(
    `zip manifest says ${packed.id} ${packed.version}, expected ${id} ${version}`
  );
}
if (!packed.license) fail('soundbase-plugin.json declares no license');
const bytes = statSync(zipPath).size;
if (bytes > ASSET_MAX_BYTES) {
  fail(`zip is ${bytes} bytes; the Lab caps assets at ${ASSET_MAX_BYTES}`);
}
log(
  `${relative(ROOT, zipPath)}: ${id} ${version}, ${entries.length} entries, ${(bytes / 1024 / 1024).toFixed(1)} MB`
);

// -- publish -----------------------------------------------------------------

if (dryRun) {
  log(
    `dry run: nothing committed, tagged or pushed. attach ${relative(ROOT, zipPath)} to a GitHub Release by hand, or rerun with a version`
  );
  process.exit(0);
}

run('git', ['push', 'origin', 'main', tag]);
run('gh', [
  'release',
  'create',
  tag,
  zipPath,
  '--verify-tag',
  '--title',
  tag,
  '--notes',
  flag('--notes') ?? tag,
]);
log(
  `released ${tag}. next: Lab > my submissions > update release > ${tag}, then approve it in ops`
);
