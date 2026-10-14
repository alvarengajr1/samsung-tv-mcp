// Client for the local API of Samsung Tizen TVs (2016+).
//   8001/8002  REST + remote-control WebSocket (8002 = TLS + token)
//   9197       UPnP/DLNA RenderingControl (absolute volume and mute, no token needed)
//   8080       DIAL (open YouTube straight into a video)
//   WoL        wakes the TV by MAC once its API is already down
import WebSocket from 'ws';
import dgram from 'node:dgram';
import net from 'node:net';
import os from 'node:os';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { KNOWN_APP_IDS } from './apps.mjs';

const RENDERING = 'urn:schemas-upnp-org:service:RenderingControl:1';
const DEFAULT_PORTS = { rest: 8001, ws: 8002, dlna: 9197, dial: 8080 };

export class TvError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // bad_request | not_paired | tv_off
  }
}

const readJson = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Private IPv4 addresses of this machine, used to guess which /24 to scan.
export const lanAddresses = () =>
  Object.values(os.networkInterfaces())
    .flat()
    .filter((nic) => nic?.family === 'IPv4' && !nic.internal && /^(192\.168|10|172\.(1[6-9]|2\d|3[01]))\./.test(nic.address))
    .map((nic) => nic.address);

export class SamsungTV {
  /**
   * @param {object} options
   * @param {string} options.dataDir     where config.json (IP, MAC) and token.json live
   * @param {string} [options.host]      TV address; skips discovery when given
   * @param {string} [options.clientName] name shown in the TV's "Allow" pop-up
   * @param {string[]} [options.extraApps] app IDs to probe besides the built-in catalog
   * @param {object} [options.ports]     override ports (tests run a fake TV on one local port)
   * @param {boolean} [options.secure]   wss on 8002 (real TVs) or plain ws (tests)
   * @param {string[]} [options.subnets] /24 prefixes to scan, e.g. ["192.168.1"]
   */
  constructor({ dataDir, host, clientName = 'samsung-tv-mcp', extraApps = [], ports = {}, secure = true, subnets } = {}) {
    mkdirSync(dataDir, { recursive: true });
    this.configFile = join(dataDir, 'config.json');
    this.tokenFile = join(dataDir, 'token.json');
    this.config = readJson(this.configFile);
    if (host) this.config.ip = host;
    this.fixedHost = Boolean(host);
    this.token = readJson(this.tokenFile).token || null;
    this.clientName = Buffer.from(clientName).toString('base64');
    this.extraApps = extraApps;
    this.ports = { ...DEFAULT_PORTS, ...ports };
    this.secure = secure;
    this.subnets = subnets;
    this.ws = null;
    this.pending = null;
    this.link = 'disconnected'; // disconnected | connecting | awaiting-approval | connected | denied | timeout
    this.apps = null;
    this.lastScan = 0;
  }

  saveConfig(patch) {
    Object.assign(this.config, patch);
    writeFileSync(this.configFile, JSON.stringify(this.config, null, 2));
  }

  saveToken(token) {
    this.token = token;
    writeFileSync(this.tokenFile, JSON.stringify({ token }, null, 2));
  }

  url(port, path) {
    return `http://${this.config.ip}:${this.ports[port]}${path}`;
  }

  // --- REST ---------------------------------------------------------------

  async fetchInfo(ip, timeout = 1500) {
    try {
      const res = await fetch(`http://${ip}:${this.ports.rest}/api/v2/`, { signal: AbortSignal.timeout(timeout) });
      const body = await res.json();
      return body.device?.type === 'Samsung SmartTV' ? body.device : null;
    } catch {
      return null;
    }
  }

  async info() {
    if (!this.config.ip) return null;
    const device = await this.fetchInfo(this.config.ip);
    if (device && device.id !== this.config.id) {
      this.saveConfig({ id: device.id, name: device.name, model: device.modelName, mac: device.wifiMac });
    }
    return device;
  }

  // Scans a /24 for port 8001. Covers first use and DHCP handing the TV a new address;
  // once a TV is known, only that same TV (by ID) is accepted.
  async discover(subnets = this.subnets ?? lanAddresses().map((ip) => ip.split('.').slice(0, 3).join('.'))) {
    this.lastScan = Date.now();
    const probe = (ip) =>
      new Promise((resolve) => {
        const socket = net.connect({ host: ip, port: this.ports.rest, timeout: 700 });
        const done = (open) => {
          socket.destroy();
          resolve(open ? ip : null);
        };
        socket.once('connect', () => done(true));
        socket.once('timeout', () => done(false));
        socket.once('error', () => done(false));
      });
    for (const subnet of [...new Set(subnets)]) {
      const hosts = Array.from({ length: 254 }, (_, i) => `${subnet}.${i + 1}`);
      const open = (await Promise.all(hosts.map(probe))).filter(Boolean);
      for (const ip of open) {
        const device = await this.fetchInfo(ip);
        if (device && (!this.config.id || device.id === this.config.id)) {
          this.saveConfig({ ip, id: device.id, name: device.name, model: device.modelName, mac: device.wifiMac });
          return device;
        }
      }
    }
    return null;
  }

  // --- Remote-control WebSocket --------------------------------------------

  connect({ approvalTimeout = 30000 } = {}) {
    if (this.ws && this.link === 'connected') return Promise.resolve();
    if (this.pending) return this.pending;
    if (!this.config.ip) return Promise.reject(new TvError('tv_off', 'No TV found on the network'));

    const hadToken = Boolean(this.token);
    const scheme = this.secure ? 'wss' : 'ws';
    const url =
      `${scheme}://${this.config.ip}:${this.ports.ws}/api/v2/channels/samsung.remote.control?name=${this.clientName}` +
      (hadToken ? `&token=${this.token}` : '');
    // The TV serves a self-signed certificate; verification is disabled for this LAN connection only.
    const ws = new WebSocket(url, { rejectUnauthorized: false, handshakeTimeout: 4000 });
    this.link = hadToken ? 'connecting' : 'awaiting-approval';

    this.pending = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => settle('timeout', new TvError('not_paired', 'Nobody accepted the request on the TV')),
        approvalTimeout,
      );
      const settle = (link, error) => {
        if (this.pending !== promise) return;
        clearTimeout(timer);
        this.pending = null;
        this.link = link;
        if (error) {
          ws.terminate();
          reject(error);
        } else {
          this.ws = ws;
          resolve();
        }
      };

      ws.on('message', (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg.event === 'ms.channel.connect') {
          if (msg.data?.token) this.saveToken(String(msg.data.token));
          settle('connected');
        } else if (msg.event === 'ms.channel.unauthorized') {
          if (hadToken) this.saveToken(null); // token revoked on the TV: pair again
          settle('denied', new TvError('not_paired', 'The TV refused the connection'));
        } else if (msg.event === 'ms.channel.timeOut') {
          settle('timeout', new TvError('not_paired', 'Nobody accepted the request on the TV'));
        }
      });
      // The TV sometimes closes with an invalid close frame; treat it as a normal drop.
      ws.on('error', () => settle('disconnected', new TvError('tv_off', 'Cannot reach the TV')));
      ws.on('close', () => {
        settle('disconnected', new TvError('tv_off', 'Cannot reach the TV'));
        if (this.ws === ws) {
          this.ws = null;
          this.link = 'disconnected';
        }
      });
    });
    const promise = this.pending;
    return promise;
  }

  // Opens the "Allow" pop-up on the TV and waits for someone to accept it.
  // With a working token it just reconnects, unless `force` asks for a fresh pairing.
  async pair({ approvalTimeout = 30000, force = false } = {}) {
    if (force) {
      this.ws?.terminate();
      this.ws = null;
      this.saveToken(null);
    }
    await this.connect({ approvalTimeout });
    return { paired: Boolean(this.token) };
  }

  async send(payload) {
    if (!this.token) throw new TvError('not_paired', 'Pair with the TV first');
    await this.connect();
    this.ws.send(JSON.stringify(payload));
  }

  key(key, cmd = 'Click') {
    return this.send({
      method: 'ms.remote.control',
      params: { Cmd: cmd, DataOfCmd: key, Option: 'false', TypeOfRemote: 'SendRemoteKey' },
    });
  }

  // Replaces the content of the text field currently open on the TV.
  text(text) {
    return this.send({
      method: 'ms.remote.control',
      params: { Cmd: Buffer.from(text).toString('base64'), DataOfCmd: 'base64', TypeOfRemote: 'SendInputString' },
    });
  }

  // Asks the TV, ID by ID, which catalog apps are installed.
  async listApps({ refresh = false } = {}) {
    if (this.apps?.length && !refresh) return this.apps;
    if (!this.config.ip) throw new TvError('tv_off', 'No TV found on the network');
    const probe = async (id) => {
      try {
        const res = await fetch(this.url('rest', `/api/v2/applications/${id}`), { signal: AbortSignal.timeout(2500) });
        const app = await res.json();
        return app.name ? { id, name: app.name, running: Boolean(app.running), visible: Boolean(app.visible) } : null;
      } catch {
        return null;
      }
    };
    const ids = [...new Set([...KNOWN_APP_IDS, ...this.extraApps])];
    const apps = (await Promise.all(ids.map(probe))).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
    // An empty list from a TV that is off would read as "nothing installed"; say it is off instead.
    if (!apps.length && (await this.info())?.PowerState !== 'on') throw new TvError('tv_off', 'The TV is off or unreachable');
    this.apps = apps;
    return apps;
  }

  async launchApp(id) {
    const res = await fetch(this.url('rest', `/api/v2/applications/${id}`), {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new TvError('tv_off', `The TV did not open app ${id}`);
  }

  // DIAL: opens the TV's YouTube app straight into a video, like casting from a phone.
  async youtube(videoId) {
    const res = await fetch(this.url('dial', '/ws/apps/YouTube'), {
      method: 'POST',
      // without a YouTube Origin the TV answers 403
      headers: { 'Content-Type': 'text/plain; charset=utf-8', Origin: 'https://www.youtube.com' },
      body: `v=${videoId}`,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new TvError('tv_off', `The TV did not open the video (HTTP ${res.status})`);
  }

  // --- Power ----------------------------------------------------------------

  wake() {
    const mac = Buffer.from((this.config.mac || '').replace(/[^0-9a-f]/gi, ''), 'hex');
    if (mac.length !== 6) {
      return Promise.reject(new TvError('tv_off', 'Unknown TV MAC address; turn it on once with the physical remote'));
    }
    const packet = Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(mac)]);
    const subnetBroadcast = this.config.ip.replace(/\d+$/, '255');
    return new Promise((resolve) => {
      const socket = dgram.createSocket('udp4');
      socket.bind(() => {
        socket.setBroadcast(true);
        let left = 6;
        for (const address of [subnetBroadcast, '255.255.255.255']) {
          for (let i = 0; i < 3; i++) {
            socket.send(packet, 9, address, () => {
              if (--left === 0) {
                socket.close();
                resolve();
              }
            });
          }
        }
      });
    });
  }

  async power(on) {
    const device = await this.info();
    const state = device?.PowerState || 'off';
    if (!on) {
      if (state === 'on') await this.key('KEY_POWER');
      return;
    }
    if (state === 'on') return;
    await this.wake();
    // In standby with the network still up, WoL may be ignored; the power key does it.
    await sleep(2500);
    if ((await this.info())?.PowerState === 'standby') await this.key('KEY_POWER').catch(() => {});
  }

  // --- DLNA -----------------------------------------------------------------

  async dlna(action, args = {}) {
    const fields = Object.entries({ InstanceID: 0, Channel: 'Master', ...args })
      .map(([name, value]) => `<${name}>${value}</${name}>`)
      .join('');
    const res = await fetch(this.url('dlna', '/upnp/control/RenderingControl1'), {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${RENDERING}#${action}"` },
      body:
        '<?xml version="1.0" encoding="utf-8"?>' +
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
        `<s:Body><u:${action} xmlns:u="${RENDERING}">${fields}</u:${action}></s:Body></s:Envelope>`,
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) throw new TvError('tv_off', `DLNA ${action} failed (HTTP ${res.status})`);
    return res.text();
  }

  setVolume(level) {
    return this.dlna('SetVolume', { DesiredVolume: level });
  }

  async audio() {
    try {
      const [volume, mute] = await Promise.all([this.dlna('GetVolume'), this.dlna('GetMute')]);
      return {
        volume: Number(/<CurrentVolume>(\d+)</.exec(volume)?.[1] ?? NaN),
        muted: /<CurrentMute>1</.test(mute),
      };
    } catch {
      return { volume: NaN, muted: false };
    }
  }

  // --- State ----------------------------------------------------------------

  async state() {
    let device = await this.info();
    if (!device && !this.fixedHost && Date.now() - this.lastScan > 60000) device = await this.discover();
    if (!device) this.ws?.terminate(); // a TV that turns off does not close the channel
    const power = device?.PowerState || 'off';
    const audio = power === 'on' ? await this.audio() : { volume: NaN, muted: false };
    return {
      name: this.config.name || null,
      model: this.config.model || null,
      ip: this.config.ip || null,
      power,
      paired: Boolean(this.token),
      link: this.link,
      volume: Number.isNaN(audio.volume) ? null : audio.volume,
      muted: audio.muted,
    };
  }

  close() {
    this.ws?.terminate();
    this.ws = null;
  }
}
