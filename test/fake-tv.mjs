// A stand-in for a Samsung TV that answers the same endpoints on a single local port:
// REST (/api/v2), DLNA RenderingControl, DIAL YouTube and the remote-control WebSocket.
import http from 'node:http';
import { WebSocketServer } from 'ws';

export async function startFakeTv({ power = 'on', apps = { '3201907018807': 'Netflix', '111299001912': 'YouTube' }, approve = true } = {}) {
  const tv = {
    power,
    volume: 10,
    muted: false,
    approve,
    token: 'fake-token-123',
    keys: [],
    texts: [],
    launched: [],
    youtube: [],
    connections: [],
  };

  const readBody = (req) =>
    new Promise((resolve) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => resolve(raw));
    });

  const server = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    const json = (status, body) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));

    if (pathname === '/api/v2/' && req.method === 'GET') {
      return json(200, {
        device: { type: 'Samsung SmartTV', id: 'uuid:fake', name: 'Living room TV', modelName: 'QN00FAKE', wifiMac: 'aa:bb:cc:dd:ee:ff', PowerState: tv.power },
      });
    }
    const app = /^\/api\/v2\/applications\/([\w.-]+)$/.exec(pathname);
    if (app) {
      const name = apps[app[1]];
      if (!name) return json(404, { message: 'Not found' });
      if (req.method === 'POST') tv.launched.push(app[1]);
      return json(200, { id: app[1], name, running: tv.launched.includes(app[1]), visible: false });
    }
    if (pathname === '/upnp/control/RenderingControl1' && req.method === 'POST') {
      const body = await readBody(req);
      const action = /#(\w+)"/.exec(req.headers.soapaction)?.[1];
      if (action === 'SetVolume') tv.volume = Number(/<DesiredVolume>(\d+)</.exec(body)[1]);
      const reply = { GetVolume: `<CurrentVolume>${tv.volume}</CurrentVolume>`, GetMute: `<CurrentMute>${tv.muted ? 1 : 0}</CurrentMute>` };
      return res.writeHead(200, { 'Content-Type': 'text/xml' }).end(`<s:Envelope><s:Body>${reply[action] ?? ''}</s:Body></s:Envelope>`);
    }
    if (pathname === '/ws/apps/YouTube' && req.method === 'POST') {
      if (req.headers.origin !== 'https://www.youtube.com') return res.writeHead(403).end();
      tv.youtube.push((await readBody(req)).replace(/^v=/, ''));
      return res.writeHead(201).end();
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ server, path: '/api/v2/channels/samsung.remote.control' });
  wss.on('connection', (socket, req) => {
    const url = new URL(req.url, 'http://localhost');
    tv.connections.push({ name: Buffer.from(url.searchParams.get('name') || '', 'base64').toString(), token: url.searchParams.get('token') });
    const token = url.searchParams.get('token');
    if (token && token !== tv.token) {
      socket.send(JSON.stringify({ event: 'ms.channel.unauthorized' }));
      return;
    }
    if (!token && !tv.approve) {
      socket.send(JSON.stringify({ event: 'ms.channel.timeOut' }));
      return;
    }
    socket.send(JSON.stringify({ event: 'ms.channel.connect', data: token ? {} : { token: tv.token } }));
    socket.on('message', (raw) => {
      const { params } = JSON.parse(raw.toString());
      if (params.TypeOfRemote === 'SendRemoteKey') {
        tv.keys.push(params.DataOfCmd);
        if (params.DataOfCmd === 'KEY_POWER') tv.power = tv.power === 'on' ? 'standby' : 'on';
      } else if (params.TypeOfRemote === 'SendInputString') {
        tv.texts.push(Buffer.from(params.Cmd, 'base64').toString());
      }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  tv.port = port;
  tv.ports = { rest: port, ws: port, dlna: port, dial: port };
  tv.waitForKeys = async (count) => {
    for (let i = 0; i < 100 && tv.keys.length < count; i++) await new Promise((r) => setTimeout(r, 10));
    return tv.keys;
  };
  tv.waitForTexts = async (count) => {
    for (let i = 0; i < 100 && tv.texts.length < count; i++) await new Promise((r) => setTimeout(r, 10));
    return tv.texts;
  };
  tv.close = () =>
    new Promise((resolve) => {
      for (const client of wss.clients) client.terminate();
      wss.close();
      server.close(resolve);
    });
  return tv;
}
