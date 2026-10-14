import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SamsungTV, TvError } from '../src/tv.mjs';
import { startFakeTv } from './fake-tv.mjs';

let fake;
let tv;
const client = (options = {}) =>
  new SamsungTV({ dataDir: mkdtempSync(join(tmpdir(), 'tv-')), host: '127.0.0.1', ports: fake.ports, secure: false, ...options });

beforeEach(async () => {
  fake = await startFakeTv();
  tv = client();
});
afterEach(async () => {
  tv.close();
  await fake.close();
});

test('state reads power, identity and DLNA audio', async () => {
  const state = await tv.state();
  assert.equal(state.power, 'on');
  assert.equal(state.name, 'Living room TV');
  assert.equal(state.model, 'QN00FAKE');
  assert.equal(state.volume, 10);
  assert.equal(state.muted, false);
  assert.equal(state.paired, false);
});

test('sending a key without a token asks for pairing', async () => {
  await assert.rejects(tv.key('KEY_HOME'), (e) => e instanceof TvError && e.code === 'not_paired');
});

test('pairing stores the token and identifies the client by name', async () => {
  assert.deepEqual(await tv.pair(), { paired: true });
  assert.equal(JSON.parse(readFileSync(tv.tokenFile, 'utf8')).token, 'fake-token-123');
  assert.equal(fake.connections[0].name, 'samsung-tv-mcp');
  await tv.key('KEY_HOME');
  assert.deepEqual(await fake.waitForKeys(1), ['KEY_HOME']);
});

test('pairing that nobody accepts fails with not_paired', async () => {
  fake.approve = false;
  await assert.rejects(tv.pair(), (e) => e.code === 'not_paired');
  assert.equal(tv.link, 'timeout');
});

test('a revoked token is dropped so the next attempt pairs again', async () => {
  tv.saveToken('stale');
  await assert.rejects(tv.key('KEY_HOME'), (e) => e.code === 'not_paired');
  assert.equal(tv.token, null);
});

test('text is sent base64-encoded and decoded by the TV', async () => {
  await tv.pair();
  await tv.text('café com leite');
  assert.deepEqual(await fake.waitForTexts(1), ['café com leite']);
});

test('apps are probed one by one and only installed ones are listed', async () => {
  const apps = await tv.listApps();
  assert.deepEqual(apps.map((a) => a.name), ['Netflix', 'YouTube']);
  await tv.launchApp('3201907018807');
  assert.deepEqual(fake.launched, ['3201907018807']);
});

test('extra app IDs are probed too', async () => {
  await fake.close();
  fake = await startFakeTv({ apps: { 'com.example.app': 'Example' } });
  tv = client({ extraApps: ['com.example.app'] });
  assert.deepEqual((await tv.listApps()).map((a) => a.id), ['com.example.app']);
});

test('YouTube over DIAL sends the Origin header the TV requires', async () => {
  await tv.youtube('dQw4w9WgXcQ');
  assert.deepEqual(fake.youtube, ['dQw4w9WgXcQ']);
});

test('volume is set over DLNA', async () => {
  await tv.setVolume(23);
  assert.equal((await tv.audio()).volume, 23);
});

test('power off presses the power key only when the TV is on', async () => {
  await tv.pair();
  await tv.power(false);
  assert.deepEqual(await fake.waitForKeys(1), ['KEY_POWER']);
  fake.power = 'standby';
  await tv.power(false);
  assert.equal(fake.keys.length, 1);
});

test('listing apps on a TV that is off is an error, not an empty list', async () => {
  const offline = client({ ports: { rest: 1, ws: 1, dlna: 1, dial: 1 } });
  await assert.rejects(offline.listApps(), (e) => e.code === 'tv_off');
});

test('an unreachable TV reports power off instead of throwing', async () => {
  await fake.close();
  fake = await startFakeTv();
  const offline = client({ ports: { rest: 1, ws: 1, dlna: 1, dial: 1 } });
  const state = await offline.state();
  assert.equal(state.power, 'off');
  assert.equal(state.volume, null);
});
