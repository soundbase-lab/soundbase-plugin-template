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
import { HANDSHAKE_PREFIX, SSE_EVENTS } from '@soundbase/plugin-contract';
import { IEM_PRODUCT, PRODUCT } from '../adapter.js';

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
  for (const product of [PRODUCT, IEM_PRODUCT]) {
    assert.ok(
      declared.includes(product),
      `adapter.js announces ${product}, but soundbase-plugin.json declares only ` +
        `${declared.join(', ')}. Run \`npm run rename <id>\` to change both at once.`
    );
    assert.ok(
      product.startsWith(`plugin:${manifest.id}/`),
      `a deviceTypeId is namespaced by the plugin id: expected ` +
        `plugin:${manifest.id}/… but adapter.js announces ${product}`
    );
  }
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

// ---------------------------------------------------------------------------
// ChannelMonitoring + PropertyControl, through the synthetic IEM
// ---------------------------------------------------------------------------

const IEM_ID = 'synthetic-iem:1';
const IEM_PATH = `/devices/${encodeURIComponent(IEM_ID)}`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// a minimal SSE reader: collects { event, data } records until closed
async function openEvents() {
  const controller = new AbortController();
  const res = await fetch(`${handle.url}/events`, {
    signal: controller.signal,
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const records = [];
  let buffer = '';
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (frame.startsWith(':')) continue;
          const event = /^event: (.*)$/m.exec(frame)?.[1];
          const data = /^data: (.*)$/m.exec(frame)?.[1];
          records.push({ event, data: data ? JSON.parse(data) : null });
        }
      }
    } catch {
      // aborted by the test
    }
  })();
  return { records, close: () => controller.abort() };
}

const stateFor = (records, key) =>
  records
    .filter(
      (r) => r.event === SSE_EVENTS.DEVICE_STATE && r.data.deviceId === IEM_ID
    )
    .flatMap((r) => r.data.patches)
    .filter((p) => p.key === key);

test('the synthetic IEM is discovered and owning it opens it', async (t) => {
  const stream = await openEvents();
  t.after(() => stream.close());

  const listed = await request('GET', '/devices');
  const found = listed.body.devices.find((d) => d.id === IEM_ID);
  assert.ok(found, 'discovered');
  assert.equal(found.product, IEM_PRODUCT);
  assert.equal(found.channelCount, undefined, 'closed until owned');

  const added = await request('POST', '/devices', {
    id: IEM_ID,
    product: IEM_PRODUCT,
  });
  assert.equal(added.status, 201);
  await delay(120);

  const { body } = await request('GET', '/devices');
  const device = body.devices.find((d) => d.id === IEM_ID);
  assert.equal(device.status.status, 'ok');
  assert.equal(device.channelCount, 2);
  assert.deepEqual(
    device.properties.map((p) => p.id),
    ['txPower', 'mute', 'frequency', 'channelName']
  );
  // the manifest layout, normalised, travels on the device row
  assert.equal(device.layout.channel[0].type, 'group');
  assert.equal(device.layout.entities.receiver.length, 4);

  // the complete state arrived on device-state
  const names = stateFor(stream.records, 'channelName');
  assert.deepEqual(names[0].value, { channels: { 1: 'VOX L', 2: 'VOX R' } });
  const frequency = stateFor(stream.records, 'frequency');
  assert.deepEqual(frequency[0], {
    key: 'frequency',
    scope: 'channel',
    operation: 'merge',
    value: { channels: { 1: 518.1, 2: 542.35 } },
  });
  const packs = stateFor(stream.records, 'receivers');
  assert.equal(packs[0].entityKind, 'receiver');
  assert.deepEqual(
    packs[0].value.added.map((p) => [p.id, p.channel]),
    [
      ['pack:1', 1],
      ['pack:2', 2],
    ]
  );
  const link = stateFor(stream.records, 'x.template.packLink');
  assert.deepEqual(link[0].value, { channels: { 1: 'pack:1', 2: 'pack:2' } });

  // meters move, and arrive at the coalesced rate rather than the raw one
  const before = stateFor(stream.records, 'meters').length;
  await delay(250);
  const meters = stateFor(stream.records, 'meters').slice(before);
  assert.ok(
    meters.length >= 3 && meters.length <= 7,
    `${meters.length} meter patches in 250 ms`
  );
  const readings = meters.map((m) => m.value.channels[1].af);
  assert.ok(new Set(readings).size > 1, 'the audio meter moves');
  assert.ok(
    readings.every((v) => v <= -8 && v >= -40),
    readings.join(',')
  );
});

test('a command is accepted with 202 and the device echoes the new value as state', async (t) => {
  const stream = await openEvents();
  t.after(() => stream.close());

  const accepted = await request('POST', `${IEM_PATH}/commands`, {
    requestId: 'tx-1',
    propertyId: 'txPower',
    channelIndex: 1,
    value: 100,
  });
  assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
  assert.deepEqual(accepted.body, { requestId: 'tx-1' });
  await delay(30);
  const power = stateFor(stream.records, 'txPower');
  assert.deepEqual(power.at(-1).value, { channels: { 1: 100 } });

  // clamped and quantized, then echoed — the card shows what the device did
  await request('POST', `${IEM_PATH}/commands`, {
    propertyId: 'frequency',
    channelIndex: 2,
    value: 9_000,
  });
  await delay(30);
  assert.deepEqual(stateFor(stream.records, 'frequency').at(-1).value, {
    channels: { 2: 608 },
  });

  // a rename honours the manifest's channelName rules
  await request('POST', `${IEM_PATH}/commands`, {
    propertyId: 'channelName',
    channelIndex: 1,
    value: 'lead vocal mix',
  });
  await delay(30);
  assert.deepEqual(stateFor(stream.records, 'channelName').at(-1).value, {
    channels: { 1: 'LEAD VOC' },
  });

  // muting shows in the meters
  await request('POST', `${IEM_PATH}/commands`, {
    propertyId: 'mute',
    channelIndex: 1,
    value: true,
  });
  await delay(120);
  assert.equal(
    stateFor(stream.records, 'meters').at(-1).value.channels[1].af,
    -90
  );
});

test('a command the device cannot take is 400 with a reason', async () => {
  const unknown = await request('POST', `${IEM_PATH}/commands`, {
    propertyId: 'colour',
    channelIndex: 1,
    value: 'red',
  });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error, 'unknown_property');

  const noChannel = await request('POST', `${IEM_PATH}/commands`, {
    propertyId: 'txPower',
    value: 10,
  });
  assert.equal(noChannel.status, 400);
  assert.equal(noChannel.body.error, 'unknown_channel');
});
