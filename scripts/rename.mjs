#!/usr/bin/env node
// Give this template your plugin's identity, in one step.
//
//   node scripts/rename.mjs acme-analyzer
//   node scripts/rename.mjs acme-analyzer --name "Acme Analyzer"
//   node scripts/rename.mjs acme-analyzer --dry-run
//
// The plugin id appears in four places that must agree: the manifest's `id`,
// the `plugin:<id>/<model>` prefix of every product's `deviceTypeId`, the
// `PRODUCT` constant in adapter.js, and the npm package name. Changing one and
// missing another produces a plugin that boots, discovers a device, and then
// has that device silently ignored by the host — with one warning line in the
// plugin log as the only clue.
//
// DO THIS BEFORE YOU PUBLISH ANYTHING. The id namespaces every deviceTypeId
// you ship and is stored inside users' saved projects, so changing it later
// strands every device they configured.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const log = (msg) => process.stdout.write(`[rename] ${msg}\n`);
const fail = (msg) => {
  process.stderr.write(`[rename] ERROR: ${msg}\n`);
  process.exit(1);
};

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const id = args.find(
  (a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--name'
);

// the manifest schema's own rule, restated so the failure arrives here rather
// than as a validation error three steps later
if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
  fail(
    'usage: rename.mjs <new-id> [--name "Display Name"] [--dry-run]\n' +
      '       <new-id> is lowercase letters, digits and hyphens, e.g. acme-analyzer'
  );
}

const manifestPath = new URL('../soundbase-plugin.json', import.meta.url);
const packagePath = new URL('../package.json', import.meta.url);
const adapterPath = new URL('../adapter.js', import.meta.url);

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const oldId = manifest.id;
if (oldId === id) fail(`the plugin id is already "${id}"`);

const displayName = flag('--name');
const changes = [];

// -- manifest ----------------------------------------------------------------

manifest.id = id;
changes.push(`soundbase-plugin.json  id: ${oldId} -> ${id}`);

if (displayName) {
  changes.push(
    `soundbase-plugin.json  name: ${manifest.name} -> ${displayName}`
  );
  manifest.name = displayName;
}

for (const product of manifest.products ?? []) {
  const before = product.deviceTypeId;
  const model = before.slice(before.indexOf('/') + 1);
  product.deviceTypeId = `plugin:${id}/${model}`;
  if (before !== product.deviceTypeId) {
    changes.push(
      `soundbase-plugin.json  deviceTypeId: ${before} -> ${product.deviceTypeId}`
    );
  }
  // the family groups a manufacturer's models in the device picker; when it
  // was named after the plugin, keep it that way
  if (product.family?.id === oldId) {
    product.family.id = id;
    if (displayName) product.family.name = displayName;
    changes.push(`soundbase-plugin.json  family.id: ${oldId} -> ${id}`);
  }
}

// -- package.json ------------------------------------------------------------

const pkgText = readFileSync(packagePath, 'utf8');
const pkg = JSON.parse(pkgText);
const pkgName = `soundbase-plugin-${id}`;
changes.push(`package.json           name: ${pkg.name} -> ${pkgName}`);
pkg.name = pkgName;
if (displayName) pkg.description = `SoundBase plugin: ${displayName}.`;

// -- adapter.js --------------------------------------------------------------
//
// A string replace, not a parse: the constant is meant to stay a literal an
// author can read at a glance.

const adapterText = readFileSync(adapterPath, 'utf8');
const productRe = new RegExp(`plugin:${oldId}/`, 'g');
const adapterNext = adapterText.replace(productRe, `plugin:${id}/`);
const adapterHits = (adapterText.match(productRe) ?? []).length;
if (adapterHits === 0) {
  log(
    `WARNING: adapter.js mentions no plugin:${oldId}/… product — check it by hand`
  );
} else {
  changes.push(`adapter.js             ${adapterHits} product id(s) rewritten`);
}

// -- apply -------------------------------------------------------------------

for (const change of changes) log(change);

if (dryRun) {
  log('dry run: nothing written');
  process.exit(0);
}

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
writeFileSync(adapterPath, adapterNext);

log(
  'done. Next: `npm test` (the suite reads the manifest, so it should still pass),'
);
log(
  'then update README.md, LICENSE and the repository/maintainers fields by hand.'
);
