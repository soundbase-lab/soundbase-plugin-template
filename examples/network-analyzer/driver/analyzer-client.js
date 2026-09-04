// A line-oriented TCP client for the instrument described in protocol.md.
//
// The point of keeping this in driver/ rather than in adapter.js: everything
// here is about the *wire*, and none of it knows what SoundBase is. It can be
// tested against the fake instrument on its own, and swapping the transport
// (serial instead of TCP, say) touches only this file.

import net from 'node:net';

const CONNECT_TIMEOUT_MS = 3_000;
const REPLY_TIMEOUT_MS = 5_000;

export class AnalyzerClient {
  #socket = null;
  #buffered = '';
  #pending = [];

  constructor({ host, port }) {
    this.host = host;
    this.port = port;
    /** set by the adapter; called when the transport dies unprompted */
    this.onFatal = null;
  }

  async connect() {
    this.#socket = await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(
          new Error(
            `${this.host}:${this.port} did not accept a connection in 3s`
          )
        );
      }, CONNECT_TIMEOUT_MS);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.setNoDelay(true);
        resolve(socket);
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    this.#socket.on('data', (chunk) => this.#consume(chunk));

    // A transport that dies while nobody is waiting on it is the case that
    // matters: someone unplugs the instrument between sweeps. Reject anything
    // in flight, then tell the adapter, which tells the shell, which reports
    // the device as failed instead of leaving a dead device looking healthy.
    const die = (err) => {
      const reason =
        err ?? new Error(`connection to ${this.host}:${this.port} closed`);
      for (const { reject } of this.#pending.splice(0)) reject(reason);
      this.onFatal?.(reason);
    };
    this.#socket.on('error', die);
    this.#socket.on('close', () => die(null));
  }

  #consume(chunk) {
    this.#buffered += chunk;
    let index;
    while ((index = this.#buffered.indexOf('\n')) >= 0) {
      const line = this.#buffered.slice(0, index).trim();
      this.#buffered = this.#buffered.slice(index + 1);
      const waiter = this.#pending.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(line);
      }
    }
  }

  /** Send one line and resolve with the one line that comes back. */
  async command(line) {
    if (!this.#socket || this.#socket.destroyed) {
      throw new Error(`not connected to ${this.host}:${this.port}`);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // drop the waiter so a late reply is not matched to the next command
        const i = this.#pending.findIndex((p) => p.timer === timer);
        if (i >= 0) this.#pending.splice(i, 1);
        reject(new Error(`no reply to "${line}" within ${REPLY_TIMEOUT_MS}ms`));
      }, REPLY_TIMEOUT_MS);
      this.#pending.push({ resolve, reject, timer });
      this.#socket.write(`${line}\n`);
    });
  }

  /** `OK 470000000 616000000` -> [470000000, 616000000] */
  async setting(line) {
    const reply = await this.command(line);
    if (!reply.startsWith('OK ')) throw new Error(`${line} -> ${reply}`);
    return reply.slice(3).split(/\s+/);
  }

  async identify() {
    const [manufacturer, model, firmware] = (await this.command('*IDN?')).split(
      ','
    );
    return { manufacturer, model, firmware };
  }

  async sweep() {
    const reply = await this.command('SWEEP?');
    if (reply.startsWith('ERR')) throw new Error(reply);
    return reply.split(',').map(Number);
  }

  close() {
    this.onFatal = null; // a close we asked for is not a fatal error
    this.#socket?.destroy();
    this.#socket = null;
  }
}

/**
 * Is there an instrument at this address? Used by discovery, so it must be
 * quick and must never throw — an address that does not answer is simply an
 * address with nothing on it.
 */
export async function probe({ host, port }) {
  const client = new AnalyzerClient({ host, port });
  try {
    await client.connect();
    const identity = await client.identify();
    return identity.model ? identity : null;
  } catch {
    return null;
  } finally {
    client.close();
  }
}
