#!/usr/bin/env node
// Validate soundbase-plugin.json against the plugin contract.
//
// SoundBase validates your manifest before it will spawn your plugin, so an
// invalid one means the plugin never starts and never explains why. Checking it
// in CI turns that into a build failure with a path and a message.
//
// `validateManifest` is the contract package's own validator — the same code
// the host and the shell run.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateManifest } from '@soundbase/plugin-contract';

const file = fileURLToPath(
  new URL('../soundbase-plugin.json', import.meta.url)
);
const result = validateManifest(JSON.parse(readFileSync(file, 'utf8')));

if (!result.ok) {
  process.stderr.write('soundbase-plugin.json is not valid:\n');
  for (const error of result.errors) process.stderr.write(`  - ${error}\n`);
  process.exit(1);
}

const { id, name, version, products, contract } = result.manifest;
process.stdout.write(`${name} (${id}) ${version}\n`);
process.stdout.write(
  `  contract: core ${contract.core}` +
    Object.entries(contract.modules ?? {})
      .map(([module, moduleVersion]) => `, ${module} ${moduleVersion}`)
      .join('') +
    '\n'
);
for (const product of products) {
  process.stdout.write(`  product:  ${product.deviceTypeId}\n`);
}

// The id namespaces every deviceTypeId you publish and appears in a user's
// saved projects, so changing it later strands their configured devices.
if (id === 'template') {
  process.stderr.write(
    '\nWARNING: the manifest id is still "template". Run `npm run rename ' +
      '<your-id>` before publishing — the id namespaces your deviceTypeIds ' +
      "and is stored in users' projects, so it cannot be changed painlessly " +
      'later.\n'
  );
}
