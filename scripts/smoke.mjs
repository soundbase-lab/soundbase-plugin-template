#!/usr/bin/env node
// Boot the plugin the way SoundBase does and check it answers.
//
// Unit tests import your adapter. This does not: it spawns `main.js` as a
// child process, reads the stdout handshake, and talks HTTP — the same three
// things the host does. A plugin whose tests pass but whose handshake never
// arrives is invisible to SoundBase, and the symptom is "my plugin does not
// appear" with nothing in any log to explain it.
//
// Devices are optional on purpose. If discoverDevices() finds nothing — which
// is the normal case for a hardware plugin on a CI runner — the sweep checks
// are skipped and reported as skipped. Boot and the handshake are still
// proven, and those are the parts that break silently.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HANDSHAKE = 'SB_PLUGIN_READY ';
const BOOT_TIMEOUT_MS = 20_000;
const TRACE_TIMEOUT_MS = 15_000;

const main = fileURLToPath(new URL('../main.js', import.meta.url));
const ok = (msg) => process.stdout.write(`  ok    ${msg}\n`);
const skip = (msg) => process.stdout.write(`  skip  ${msg}\n`);

const child = spawn(process.execPath, [main], {
  stdio: ['ignore', 'pipe', 'inherit'],
});
let failed = false;
const finish = (code) => {
  child.kill();
  process.exit(code);
};

process.stdout.write('booting the plugin\n');

const port = await new Promise((resolve, reject) => {
  const timer = setTimeout(
    () =>
      reject(
        new Error(
          `no ${HANDSHAKE.trim()} line within ${BOOT_TIMEOUT_MS / 1000}s. ` +
            'The host waits for this and gives up the same way.'
        )
      ),
    BOOT_TIMEOUT_MS
  );
  let buffered = '';
  child.stdout.on('data', (chunk) => {
    buffered += chunk;
    process.stdout.write(chunk);
    const line = buffered.split('\n').find((l) => l.startsWith(HANDSHAKE));
    if (!line) return;
    clearTimeout(timer);
    try {
      resolve(JSON.parse(line.slice(HANDSHAKE.length)).port);
    } catch (err) {
      reject(new Error(`handshake line is not valid JSON: ${line}`));
    }
  });
  child.on('error', reject);
  child.on('exit', (code) =>
    reject(new Error(`the plugin exited before handshaking (code ${code})`))
  );
}).catch((err) => {
  process.stderr.write(`\nFAILED: ${err.message}\n`);
  finish(1);
});

const base = `http://127.0.0.1:${port}`;
const get = async (path) => {
  const res = await fetch(`${base}${path}`);
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
};
const post = async (path, body) => {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status}`);
  return res.json();
};

try {
  ok(`handshake reported port ${port}`);

  const health = await get('/health');
  if (health.ok !== true) throw new Error('/health did not report ok');
  ok('/health');

  const info = await get('/info');
  ok(`/info — ${info.name} ${info.version}, core ${info.contract.core}`);

  const { devices } = await get('/devices');
  ok(`/devices — ${devices.length} discovered`);

  if (devices.length === 0) {
    skip('no device discovered, so the sweep path was not exercised');
    skip('(expected for a hardware plugin on a runner with nothing attached)');
  } else {
    const device = encodeURIComponent(devices[0].id);
    const caps = devices[0].capabilities ?? {};
    // Sweep somewhere the device admits it can reach; a hardware adapter is
    // entitled to reject anything else.
    const startHz = Number.isFinite(caps.minFrequencyHz)
      ? caps.minFrequencyHz
      : 470_000_000;
    const stopHz = Number.isFinite(caps.maxFrequencyHz)
      ? Math.min(caps.maxFrequencyHz, startHz + 146_000_000)
      : 616_000_000;

    const applied = await post(`/devices/${device}/configuration`, {
      startHz,
      stopHz,
      pointCount: 401,
    });
    ok(
      `configuration applied — ${applied.startHz}–${applied.stopHz} Hz, ` +
        `${applied.pointCount} points`
    );

    await post(`/devices/${device}/sweep/start`);
    ok('sweep started');

    const deadline = Date.now() + TRACE_TIMEOUT_MS;
    let trace = null;
    while (Date.now() < deadline && !trace) {
      try {
        trace = await get(`/devices/${device}/trace`);
      } catch {
        // 409 until the first sweep completes
      }
    }
    if (!trace) {
      throw new Error(
        `no trace within ${TRACE_TIMEOUT_MS / 1000}s of starting the sweep`
      );
    }
    if (trace.amplitudesDbm.length !== trace.pointCount) {
      throw new Error(
        `trace has ${trace.amplitudesDbm.length} amplitudes but claims ` +
          `pointCount ${trace.pointCount} — the host draws pointCount of them`
      );
    }
    ok(`trace — sweep ${trace.sweepId}, ${trace.pointCount} points`);

    await post(`/devices/${device}/sweep/stop`);
    ok('sweep stopped');
  }
} catch (err) {
  process.stderr.write(`\nFAILED: ${err.message}\n`);
  failed = true;
}

process.stdout.write(
  failed ? '\nsmoke check failed\n' : '\nsmoke check passed\n'
);
finish(failed ? 1 : 0);
