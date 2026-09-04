// Contract tests for the adapter, driven through the real shell over real HTTP.
//
// These are written against the *contract*, not against the synthetic signal
// source, so they keep their meaning once adapter.js talks to hardware. Read
// them as the executable half of docs/adapter-reference.md.
//
// Nothing here hardcodes the plugin's id: everything that could change when you
// run `npm run rename` is read from soundbase-plugin.json, so renaming your
// plugin never breaks the suite.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HANDSHAKE_PREFIX } from '@soundbase/plugin-contract';
import { PRODUCT } from '../adapter.js';

const manifest = JSON.parse(
  readFileSync(new URL('../soundbase-plugin.json', import.meta.url), 'utf8')
);

const DEVICE_ID = 'synthetic:1';
const DEVICE_PATH = `/devices/${encodeURIComponent(DEVICE_ID)}`;
const START_HZ = 470_000_000;
const STOP_HZ = 616_000_000;
const POINT_COUNT = 451;

// boots under the real shell, exactly as the host spawns it
const handle = await (await import('../main.js')).default;

const request = async (method, path, body) => {
  const res = await fetch(`${handle.url}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

test.after(() => handle.close());

test('the manifest is valid and the handshake reports a real port', () => {
  assert.equal(handle.manifest.id, manifest.id);
  assert.ok(handle.port > 0);
  assert.equal(HANDSHAKE_PREFIX, 'SB_PLUGIN_READY ');
});

// The rename trap: an adapter that announces a product the manifest does not
// declare produces a device the host silently ignores, and the only clue is one
// warning line in the plugin log. Catch it here instead.
test('every product the adapter announces is declared in the manifest', () => {
  const declared = manifest.products.map((p) => p.deviceTypeId);
  assert.ok(
    declared.includes(PRODUCT),
    `adapter.js announces ${PRODUCT}, but soundbase-plugin.json declares only ` +
      `${declared.join(', ')}. Run \`npm run rename <id>\` to change both at once.`
  );
  assert.ok(
    PRODUCT.startsWith(`plugin:${manifest.id}/`),
    `a deviceTypeId is namespaced by the plugin id: expected ` +
      `plugin:${manifest.id}/… but adapter.js announces ${PRODUCT}`
  );
});

test('the synthetic device is discovered, not host-added', async () => {
  const { status, body } = await request('GET', '/devices');
  assert.equal(status, 200);
  const device = body.devices.find((d) => d.id === DEVICE_ID);
  assert.ok(device, JSON.stringify(body.devices));
  assert.equal(device.product, PRODUCT);
  assert.equal(device.discovered, true);
});

// A *discovered* device is not opened until something asks it to do work — an
// idle plugin must not hold a serial port open. So `capabilities` is null in
// the first /devices listing and appears after the first operation on it.
test('open() reports capabilities the host can constrain its UI to', async () => {
  await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: START_HZ,
    stopHz: STOP_HZ,
  });

  const { body } = await request('GET', '/devices');
  const caps = body.devices.find((d) => d.id === DEVICE_ID).capabilities;
  assert.ok(caps, 'capabilities appear once the device has been opened');
  assert.ok(caps.maxFrequencyHz > caps.minFrequencyHz);
  assert.ok(Array.isArray(caps.rbwHz) && caps.rbwHz.length > 0);
  // the shell accumulates all four trace modes in software, so every device
  // advertises them whether or not the hardware has the feature
  assert.deepEqual([...caps.traceModes].sort(), [
    'average',
    'clear-write',
    'max-hold',
    'min-hold',
  ]);
});

test('config, start and trace produce a plausible spectrum', async (t) => {
  const applied = await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: START_HZ,
    stopHz: STOP_HZ,
    pointCount: POINT_COUNT,
    rbwHz: 100_000,
  });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.startHz, START_HZ);
  assert.equal(applied.body.stopHz, STOP_HZ);
  assert.equal(applied.body.pointCount, POINT_COUNT);
  assert.equal(applied.body.rbwHz, 100_000);

  const started = await request('POST', `${DEVICE_PATH}/sweep/start`);
  assert.equal(started.status, 200);
  assert.equal(started.body.sweeping, true);
  t.after(async () => {
    await request('POST', `${DEVICE_PATH}/sweep/stop`);
  });

  const trace = await request('GET', `${DEVICE_PATH}/trace`);
  assert.equal(trace.status, 200);
  assert.equal(trace.body.pointCount, POINT_COUNT);
  assert.equal(trace.body.amplitudesDbm.length, POINT_COUNT);
  assert.equal(trace.body.startHz, START_HZ);
  assert.equal(trace.body.stopHz, STOP_HZ);
  assert.equal(trace.body.stepHz, (STOP_HZ - START_HZ) / (POINT_COUNT - 1));
  assert.equal(trace.body.unit, 'dBm');
  assert.ok(trace.body.sweepId >= 1);

  const amps = trace.body.amplitudesDbm;
  // carriers sit at 33% and 66% of the span; the once-in-seven transient at 50%
  const bins = (from, to) => amps.slice(from, to);
  const floorBins = [...bins(10, 100), ...bins(360, 440)];
  const floorMin = Math.min(...floorBins);
  const floorMax = Math.max(...floorBins);
  assert.ok(floorMin >= -106, `noise floor dipped to ${floorMin}`);
  assert.ok(floorMax <= -94, `noise floor rose to ${floorMax}`);

  const floorMean = floorBins.reduce((a, b) => a + b, 0) / floorBins.length;
  const carrierA = Math.max(...bins(140, 160));
  const carrierB = Math.max(...bins(290, 306));
  assert.ok(carrierA >= floorMean + 20, `carrier A only reached ${carrierA}`);
  assert.ok(carrierB >= floorMean + 20, `carrier B only reached ${carrierB}`);
});

test('out-of-range configuration is clamped, not rejected', async () => {
  const { body } = await request('GET', '/devices');
  const caps = body.devices.find((d) => d.id === DEVICE_ID).capabilities;

  const applied = await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: 0,
    stopHz: caps.maxFrequencyHz * 10,
    pointCount: POINT_COUNT,
  });
  assert.equal(
    applied.status,
    200,
    'a request outside the range is still a 200'
  );
  assert.ok(applied.body.startHz >= caps.minFrequencyHz);
  assert.ok(applied.body.stopHz <= caps.maxFrequencyHz);
});

test('successive polls see successive sweeps', async (t) => {
  await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: START_HZ,
    stopHz: STOP_HZ,
    pointCount: POINT_COUNT,
  });
  await request('POST', `${DEVICE_PATH}/sweep/start`);
  t.after(async () => {
    await request('POST', `${DEVICE_PATH}/sweep/stop`);
  });

  const first = await request('GET', `${DEVICE_PATH}/trace`);
  const startedAt = Date.now();
  const second = await request('GET', `${DEVICE_PATH}/trace`);
  const elapsed = Date.now() - startedAt;

  assert.ok(second.body.sweepId > first.body.sweepId);
  // the long poll returns on the next sweep rather than after the hold cap
  assert.ok(elapsed < 2000, `waited ${elapsed}ms for the next sweep`);
});

test('max-hold keeps the peak of every sweep, including the transient', async (t) => {
  await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: START_HZ,
    stopHz: STOP_HZ,
    pointCount: POINT_COUNT,
    traceMode: 'max-hold',
  });
  await request('POST', `${DEVICE_PATH}/sweep/start`);
  t.after(async () => {
    await request('POST', `${DEVICE_PATH}/sweep/stop`);
  });

  // ten consecutive sweeps always contain one of the every-seventh transients
  let trace = await request('GET', `${DEVICE_PATH}/trace`);
  const target = trace.body.sweepId + 10;
  const deadline = Date.now() + 5_000;
  while (trace.body.sweepId < target && Date.now() < deadline) {
    trace = await request('GET', `${DEVICE_PATH}/trace`);
  }

  assert.ok(
    trace.body.sweepId >= target,
    `only reached sweep ${trace.body.sweepId}`
  );
  const midband = Math.max(...trace.body.amplitudesDbm.slice(220, 232));
  assert.ok(midband >= -70, `transient never accumulated (peak ${midband})`);
});
