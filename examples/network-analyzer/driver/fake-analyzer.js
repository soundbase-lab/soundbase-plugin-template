// A fake instrument, so the example has something to talk to in tests and on a
// CI runner with no hardware attached.
//
// Give every driver you write one of these. It is the difference between a
// test suite that runs everywhere and one that only runs at your desk, and it
// is also where you reproduce the failures that are hard to stage physically —
// a socket that dies mid-sweep, a reply that never comes.

import net from 'node:net';

const RBW_HZ = [1_000, 10_000, 100_000, 1_000_000];
const MIN_HZ = 9_000;
const MAX_HZ = 3_000_000_000;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const nearest = (hz, list) =>
  list.reduce((best, c) => (Math.abs(c - hz) < Math.abs(best - hz) ? c : best));

export async function startFakeAnalyzer({ port = 0 } = {}) {
  const state = {
    startHz: 470_000_000,
    stopHz: 616_000_000,
    points: 401,
    rbwHz: 100_000,
    attenDb: 0,
    detector: 'peak',
  };

  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffered = '';
    socket.on('data', (chunk) => {
      buffered += chunk;
      let index;
      while ((index = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, index).trim();
        buffered = buffered.slice(index + 1);
        const reply = handle(line, state);
        if (reply !== null) socket.write(`${reply}\n`);
      }
    });
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  return {
    port: server.address().port,
    state,
    /** drop every connection without closing the listener — a transport death */
    dropConnections() {
      for (const socket of sockets) socket.destroy();
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function handle(line, state) {
  const [command, ...args] = line.split(/\s+/);
  switch (command) {
    case '*IDN?':
      return 'ACME,SA-3000,1.4.2';
    case 'RANGE': {
      const start = clamp(Number(args[0]), MIN_HZ, MAX_HZ);
      const stop = clamp(Number(args[1]), start + 1, MAX_HZ);
      state.startHz = start;
      state.stopHz = stop;
      return `OK ${start} ${stop}`;
    }
    case 'POINTS':
      state.points = clamp(Math.round(Number(args[0])), 2, 4001);
      return `OK ${state.points}`;
    case 'RBW':
      state.rbwHz = nearest(Number(args[0]), RBW_HZ);
      return `OK ${state.rbwHz}`;
    case 'ATTEN':
      state.attenDb = clamp(Math.round(Number(args[0])), 0, 30);
      return `OK ${state.attenDb}`;
    case 'DETECTOR':
      state.detector = args[0] === 'average' ? 'average' : 'peak';
      return `OK ${state.detector}`;
    case 'SWEEP?':
      return sweep(state).join(',');
    default:
      return `ERR unknown command ${command}`;
  }
}

// a noise floor with one carrier a third of the way across, attenuated by ATTEN
function sweep(state) {
  const { startHz, stopHz, points, attenDb, detector } = state;
  const span = Math.max(1, stopHz - startHz);
  const carrier = startHz + span * 0.33;
  const jitter = detector === 'average' ? 0.5 : 2;
  const out = new Array(points);
  for (let i = 0; i < points; i += 1) {
    const f = startHz + (i * span) / (points - 1);
    const noise = -100 + (Math.random() * 2 - 1) * jitter;
    const peak = 45 * Math.exp(-(((f - carrier) / (span * 0.01)) ** 2));
    out[i] = Math.round((noise + peak - attenDb) * 10) / 10;
  }
  return out;
}
