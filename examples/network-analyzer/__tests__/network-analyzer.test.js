// The example, booted under the real shell against a fake instrument.
//
// This is the shape to copy for a hardware plugin: a fake device in driver/,
// and tests that drive the whole stack — shell, adapter, driver, socket — with
// nothing plugged in. Everything here runs on a CI runner.

import test from 'node:test';
import assert from 'node:assert/strict';
import { runPlugin, SoundBasePlugin } from '@soundbase/plugin-shell';
import { startFakeAnalyzer } from '../driver/fake-analyzer.js';
import {
  PRODUCT,
  createSpectrumAnalyzerAdapter,
  discoverDevices,
} from '../adapter.js';

const instrument = await startFakeAnalyzer();
const ADDRESS = `127.0.0.1:${instrument.port}`;
const DEVICE_ID = `net:${ADDRESS}`;
const DEVICE_PATH = `/devices/${encodeURIComponent(DEVICE_ID)}`;

// exactly what main.js does, with the example's manifest instead of the repo's
class Plugin extends SoundBasePlugin {
  async discoverDevices() {
    return discoverDevices(this.config);
  }
  createSpectrumAnalyzerAdapter(device) {
    return createSpectrumAnalyzerAdapter(device, this.config);
  }
}

const handle = await runPlugin(Plugin, {
  manifestPath: new URL('../soundbase-plugin.json', import.meta.url),
  handleSignals: false,
});

const request = async (method, path, body) => {
  const res = await fetch(`${handle.url}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

// the host's first PUT /config is what brings a plugin up; here it is also
// where the addresses discovery probes come from
await request('PUT', '/config', { values: { addresses: ADDRESS } });

test.after(async () => {
  await handle.close();
  await instrument.close();
});

test('discovery probes the configured addresses and names a stable device', async () => {
  const { body } = await request('GET', '/devices');
  const device = body.devices.find((d) => d.id === DEVICE_ID);
  assert.ok(device, `no ${DEVICE_ID} in ${JSON.stringify(body.devices)}`);
  assert.equal(device.product, PRODUCT);
  assert.equal(device.discovered, true);
  assert.deepEqual(device.transport, {
    kind: 'network',
    host: '127.0.0.1',
    port: instrument.port,
  });
});

test('an address with nothing on it is a normal empty result, not an error', async () => {
  // port 1 on loopback refuses instantly, which is the common case for a
  // user who typed an address that is not an analyzer
  const devices = await discoverDevices({ addresses: '127.0.0.1:1' });
  assert.deepEqual(devices, []);
});

test('open() reports the controls the device declares for itself', async () => {
  await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: 470_000_000,
    stopHz: 616_000_000,
    pointCount: 401,
  });
  const { body } = await request('GET', '/devices');
  const caps = body.devices.find((d) => d.id === DEVICE_ID).capabilities;
  const ids = caps.controls.map((c) => c.id);
  assert.deepEqual(ids, ['attenDb', 'detector']);
  assert.equal(caps.controls[0].unit, 'dB');
  assert.equal(caps.controls[1].type, 'dropdown');
});

test('out-of-range values come back clamped, and the request still succeeds', async () => {
  const { status, body } = await request(
    'POST',
    `${DEVICE_PATH}/configuration`,
    {
      startHz: 0,
      stopHz: 9_000_000_000,
      pointCount: 99_999,
    }
  );
  assert.equal(status, 200);
  assert.equal(body.startHz, 9_000);
  assert.equal(body.stopHz, 3_000_000_000);
  assert.equal(body.pointCount, 4001);
});

test('an unsupported RBW snaps to the nearest supported value', async () => {
  const { body } = await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: 470_000_000,
    stopHz: 616_000_000,
    pointCount: 401,
    rbwHz: 12_345,
  });
  assert.equal(body.rbwHz, 10_000);
});

test('controls are merged by id and echoed as the device settled on them', async () => {
  const first = await request('POST', `${DEVICE_PATH}/configuration`, {
    controls: { detector: 'average' },
  });
  assert.equal(first.body.controls.detector, 'average');

  // 42 dB is beyond the 0-30 dB attenuator; the echo is what it managed
  const second = await request('POST', `${DEVICE_PATH}/configuration`, {
    controls: { attenDb: 42 },
  });
  assert.equal(second.body.controls.attenDb, 30);
  assert.equal(
    second.body.controls.detector,
    'average',
    'the untouched control survived'
  );
});

test('sweeping produces traces whose geometry matches the effective config', async (t) => {
  // controls persist across configuration calls, so undo the previous test's
  // 30 dB of attenuation explicitly rather than assuming a clean instrument
  const applied = await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: 470_000_000,
    stopHz: 616_000_000,
    pointCount: 401,
    controls: { attenDb: 0 },
  });
  await request('POST', `${DEVICE_PATH}/sweep/start`);
  t.after(() => request('POST', `${DEVICE_PATH}/sweep/stop`));

  const { status, body } = await request('GET', `${DEVICE_PATH}/trace`);
  assert.equal(status, 200);
  assert.equal(body.pointCount, applied.body.pointCount);
  assert.equal(body.amplitudesDbm.length, applied.body.pointCount);
  assert.equal(body.startHz, applied.body.startHz);
  assert.ok(body.sweepId >= 1);

  // the fake instrument's carrier sits a third of the way across the span
  const carrierBin = Math.round(401 * 0.33);
  const carrier = Math.max(
    ...body.amplitudesDbm.slice(carrierBin - 4, carrierBin + 4)
  );
  assert.ok(carrier > -70, `carrier only reached ${carrier}`);
});

test('a transport that dies mid-sweep marks the device failed, not healthy', async () => {
  await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: 470_000_000,
    stopHz: 616_000_000,
    pointCount: 401,
  });
  await request('POST', `${DEVICE_PATH}/sweep/start`);

  instrument.dropConnections();

  const deadline = Date.now() + 5_000;
  let status = null;
  while (Date.now() < deadline) {
    const { body } = await request('GET', '/devices');
    status = body.devices.find((d) => d.id === DEVICE_ID)?.status?.status;
    if (status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(
    status,
    'failed',
    'onFatal is what turns a dead socket into a device SoundBase reports as broken'
  );
});
