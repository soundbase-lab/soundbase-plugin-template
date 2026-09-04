#!/usr/bin/env node
// Check that this plugin is in a state SoundBase will accept, and say exactly
// what to do about anything that is not.
//
//   npm run doctor
//
// Run it when something does not work and you do not yet know which layer is
// wrong. It never touches the network or any hardware — every check reads a
// file or asks Node about itself, so it is safe to run anywhere, including on
// a machine with nothing attached.
//
// For "my plugin does not appear in SoundBase", run this first, then
// `npm run smoke` — between them they cover every failure that produces no
// visible error at all. See docs/troubleshooting.md.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_URL = new URL('..', import.meta.url);
const ROOT = fileURLToPath(ROOT_URL);
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const has = (rel) => existsSync(join(ROOT, rel));

// Line endings are not an edit. Git on Windows checks text files out as CRLF
// unless a .gitattributes says otherwise, so hashing raw bytes reports the
// runner's git config as "someone changed main.js". Normalise first, and the
// warning means what it says. scripts/build-template-repo.mjs stamps the hash
// below through the same normalisation.
const contentHash = (buf) =>
  createHash('sha256')
    .update(buf.toString('utf8').replace(/\r\n/g, '\n'))
    .digest('hex');

// main.js is the shell bootstrap and is meant to be byte-identical across every
// plugin. Editing it is almost always a mistake — whatever you wanted belongs
// in adapter.js — and it is the kind of mistake that is invisible in a diff
// review months later, so it is worth naming.
//
// Stamped by scripts/build-template-repo.mjs when this repository is
// assembled, so it always matches the main.js shipped beside it. Do not edit.
const MAIN_JS_SHA256 =
  '7a5d1642fe69418c695b5e17a549aabbe8f605dab446b8add8ce9674e801f1a5';

let failures = 0;
let warnings = 0;
const ok = (msg) => process.stdout.write(`  ok    ${msg}\n`);
const warn = (msg, fix) => {
  warnings += 1;
  process.stdout.write(`  warn  ${msg}\n${fix ? `        → ${fix}\n` : ''}`);
};
const bad = (msg, fix) => {
  failures += 1;
  process.stdout.write(`  FAIL  ${msg}\n${fix ? `        → ${fix}\n` : ''}`);
};
const section = (title) => process.stdout.write(`\n${title}\n`);

// -- environment -------------------------------------------------------------

section('environment');

const major = Number(process.versions.node.split('.')[0]);
if (major >= 20) ok(`node ${process.versions.node}`);
else
  bad(
    `node ${process.versions.node} is too old`,
    'the shell needs Node 20 or newer'
  );

// -- the SDK -----------------------------------------------------------------

section('sdk');

const sdkPath = (pkg, rel = 'package.json') =>
  join('node_modules', '@soundbase', pkg, rel);

let contract = null;
for (const pkg of ['plugin-contract', 'plugin-shell']) {
  if (!has(sdkPath(pkg))) {
    bad(
      `@soundbase/${pkg} is not installed`,
      'npm install  (both SDK packages are on public npm)'
    );
    continue;
  }
  const version = JSON.parse(read(sdkPath(pkg))).version;
  ok(`@soundbase/${pkg} ${version}`);
}

if (has(sdkPath('plugin-contract'))) {
  // the normative documents ship inside the dependency, so they always match
  // the shell version installed here — no copy to go stale
  const specs = [
    'soundbase-plugin.schema.json',
    'core.openapi.yaml',
    'spectrum-analyzer.openapi.yaml',
  ];
  const missing = specs.filter(
    (s) => !has(sdkPath('plugin-contract', join('spec', s)))
  );
  if (missing.length) {
    warn(
      `the contract package is installed but ${missing.join(', ')} is missing`,
      'reinstall the SDK; the spec/ directory is the normative reference'
    );
  } else {
    ok(`spec documents at ${sdkPath('plugin-contract', 'spec/')}`);
  }
  contract = await import('@soundbase/plugin-contract').catch((err) => {
    bad(
      `@soundbase/plugin-contract does not load: ${err.message}`,
      'rm -rf node_modules && npm install'
    );
    return null;
  });
}

// -- the manifest ------------------------------------------------------------

section('manifest');

let manifest = null;
try {
  manifest = JSON.parse(read('soundbase-plugin.json'));
} catch (err) {
  bad(`soundbase-plugin.json is not readable JSON: ${err.message}`);
}

if (manifest && contract) {
  const result = contract.validateManifest(manifest);
  if (result.ok)
    ok(`${manifest.name} (${manifest.id}) ${manifest.version} validates`);
  else {
    bad(
      'soundbase-plugin.json does not validate',
      'the host refuses to spawn a plugin whose manifest is invalid'
    );
    for (const e of result.errors) process.stdout.write(`          - ${e}\n`);
  }

  // A manifest declaring a contract version the installed shell does not
  // implement boots fine and then behaves in ways neither side documents.
  const declaredCore = manifest.contract?.core;
  if (declaredCore !== contract.CORE_CONTRACT_VERSION) {
    warn(
      `manifest declares core ${declaredCore}, the installed contract is ${contract.CORE_CONTRACT_VERSION}`,
      'match them, or pin an SDK version that implements what you declare'
    );
  } else {
    ok(`core contract ${declaredCore}`);
  }
  const declaredSa = manifest.contract?.modules?.SpectrumAnalyzer;
  if (declaredSa && declaredSa !== contract.SA_MODULE_VERSION) {
    warn(
      `manifest declares SpectrumAnalyzer ${declaredSa}, the installed contract is ${contract.SA_MODULE_VERSION}`
    );
  }
}

if (manifest?.id === 'template') {
  warn(
    'the plugin id is still "template"',
    'npm run rename <your-id>  — the id namespaces every deviceTypeId you ship ' +
      "and is stored in users' projects, so change it before you publish anything"
  );
}

if (manifest && !manifest.license) {
  warn(
    'the manifest declares no license',
    'the Lab refuses a release whose manifest has no license'
  );
}

// These are shown to users deciding whether to trust a plugin enough to run it
// with their own privileges, so a shipped `your-org` is worse than an absent
// field: it looks like a real answer.
if (/your-org/.test(manifest?.repository ?? '')) {
  warn(
    '`repository` still points at the placeholder',
    'set it to your own repository, or remove the field'
  );
}
if ((manifest?.maintainers ?? []).some((m) => m?.name === 'Your Name')) {
  warn(
    '`maintainers` still holds the placeholder',
    'name yourself, or remove the field'
  );
}

// -- the entrypoint ----------------------------------------------------------

section('entrypoint');

const entrypoint = manifest?.runtime?.entrypoint ?? 'main.js';
if (!has(entrypoint)) {
  bad(`runtime.entrypoint is ${entrypoint}, which does not exist`);
} else {
  const digest = contentHash(readFileSync(join(ROOT, entrypoint)));
  if (entrypoint === 'main.js' && digest !== MAIN_JS_SHA256) {
    warn(
      'main.js has been edited',
      'it is the shell bootstrap and is byte-identical across every plugin — ' +
        'whatever you added almost certainly belongs in adapter.js'
    );
  } else {
    ok(`${entrypoint} present`);
  }
}

// -- the adapter -------------------------------------------------------------

section('adapter');

if (!has('adapter.js')) {
  bad('adapter.js does not exist', 'main.js imports it by name');
} else {
  // By URL, not by path. `import('D:\plugin\adapter.js')` is read as a
  // specifier whose scheme is `d:`, which the ESM loader refuses — so an
  // absolute path works everywhere except Windows, where it fails on every
  // run.
  const adapter = await import(new URL('adapter.js', ROOT_URL).href).catch(
    (err) => {
      bad(`adapter.js does not load: ${err.message}`);
      return null;
    }
  );
  if (adapter) {
    for (const fn of ['discoverDevices', 'createSpectrumAnalyzerAdapter']) {
      if (typeof adapter[fn] === 'function') ok(`exports ${fn}()`);
      else
        bad(
          `adapter.js does not export ${fn}()`,
          'main.js imports both by name'
        );
    }

    // the rename trap, checked without booting anything
    const declared = (manifest?.products ?? []).map((p) => p.deviceTypeId);
    if (typeof adapter.PRODUCT === 'string') {
      if (declared.includes(adapter.PRODUCT))
        ok(`PRODUCT ${adapter.PRODUCT} is declared`);
      else
        bad(
          `adapter.js announces ${adapter.PRODUCT}, which the manifest does not declare ` +
            `(it declares ${declared.join(', ') || 'nothing'})`,
          'npm run rename <your-id> changes both at once'
        );
    }
  }
}

// -- licence -----------------------------------------------------------------

section('licence');

if (!has('LICENSE')) {
  bad(
    'there is no LICENSE file',
    'the Lab requires one at the root of a release zip'
  );
} else if (read('LICENSE').includes('<<<PLACEHOLDER:')) {
  warn(
    'LICENSE still contains placeholders',
    'fill them in, or replace the file with your own licence, before publishing'
  );
} else {
  ok('LICENSE present');
}

// -- verdict -----------------------------------------------------------------

process.stdout.write(
  `\n${failures} failure(s), ${warnings} warning(s)\n` +
    (failures
      ? 'fix the failures above, then run `npm run smoke` to prove the plugin boots\n'
      : 'next: `npm test`, then `npm run smoke`\n')
);
process.exit(failures ? 1 : 0);
