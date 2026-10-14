// End to end through the MCP protocol: a real MCP client talks to the server over an
// in-memory transport, and the server talks to the fake TV over HTTP and WebSocket.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SamsungTV } from '../src/tv.mjs';
import { createServer, parseYouTubeId, resolveKey } from '../src/mcp.mjs';
import { startFakeTv } from './fake-tv.mjs';

let fake;
let tv;
let client;

const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  return { error: Boolean(result.isError), data: JSON.parse(result.content[0].text) };
};

beforeEach(async () => {
  fake = await startFakeTv();
  tv = new SamsungTV({ dataDir: mkdtempSync(join(tmpdir(), 'tv-')), host: '127.0.0.1', ports: fake.ports, secure: false });
  const server = createServer(tv, { maxVolume: 40, keyDelayMs: 0 });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
});
afterEach(async () => {
  await client.close();
  tv.close();
  await fake.close();
});

test('lists the tools with read-only hints on the safe ones', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    'tv_launch_app', 'tv_list_apps', 'tv_pair', 'tv_play_youtube', 'tv_power',
    'tv_press_keys', 'tv_set_volume', 'tv_status', 'tv_type_text',
  ]);
  const readOnly = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name).sort();
  assert.deepEqual(readOnly, ['tv_list_apps', 'tv_status']);
});

test('the server ships instructions for the model', () => {
  assert.match(client.getInstructions(), /tv_status/);
});

test('tv_status before pairing', async () => {
  const { error, data } = await call('tv_status');
  assert.equal(error, false);
  assert.equal(data.power, 'on');
  assert.equal(data.paired, false);
});

test('keys need pairing, and the error says so', async () => {
  const { error, data } = await call('tv_press_keys', { keys: ['home'] });
  assert.equal(error, true);
  assert.equal(data.error, 'not_paired');
});

test('pair, then press keys by alias and by raw code', async () => {
  assert.deepEqual((await call('tv_pair')).data, { paired: true });
  const { data } = await call('tv_press_keys', { keys: ['home', 'down', 'ok', 'KEY_RED'] });
  assert.deepEqual(data.pressed, ['KEY_HOME', 'KEY_DOWN', 'KEY_ENTER', 'KEY_RED']);
  assert.deepEqual(await fake.waitForKeys(4), ['KEY_HOME', 'KEY_DOWN', 'KEY_ENTER', 'KEY_RED']);
});

test('volume above the cap is refused and the TV is untouched', async () => {
  const { error, data } = await call('tv_set_volume', { level: 80 });
  assert.equal(error, true);
  assert.match(data.message, /cap of 40/);
  assert.equal(fake.volume, 10);
  assert.deepEqual((await call('tv_set_volume', { level: 25 })).data, { volume: 25 });
});

test('volume keys cannot be used to get around the cap', async () => {
  await call('tv_pair');
  const { error } = await call('tv_press_keys', { keys: Array(6).fill('volume_up') });
  assert.equal(error, true);
  assert.equal(fake.keys.length, 0);
});

test('the power key is routed to tv_power', async () => {
  await call('tv_pair');
  const { error, data } = await call('tv_press_keys', { keys: ['KEY_POWER'] });
  assert.equal(error, true);
  assert.match(data.message, /tv_power/);
});

test('launch an app by partial name', async () => {
  const { data } = await call('tv_launch_app', { app: 'netf' });
  assert.equal(data.launched.name, 'Netflix');
  assert.deepEqual(fake.launched, ['3201907018807']);
});

test('an unknown app lists what is installed', async () => {
  const { error, data } = await call('tv_launch_app', { app: 'hulu' });
  assert.equal(error, true);
  assert.match(data.message, /Installed: Netflix, YouTube/);
});

test('play a YouTube URL', async () => {
  const { data } = await call('tv_play_youtube', { video: 'https://youtu.be/dQw4w9WgXcQ?t=42' });
  assert.equal(data.playing, 'dQw4w9WgXcQ');
  assert.deepEqual(fake.youtube, ['dQw4w9WgXcQ']);
});

test('type text into the open field', async () => {
  await call('tv_pair');
  await call('tv_type_text', { text: 'stranger things' });
  assert.deepEqual(await fake.waitForTexts(1), ['stranger things']);
});

test('power off goes to standby', async () => {
  await call('tv_pair');
  const { data } = await call('tv_power', { on: false });
  assert.equal(data.power, 'standby');
});

test('YouTube ID parsing', () => {
  for (const input of [
    'dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=x',
    'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    'https://www.youtube.com/embed/dQw4w9WgXcQ',
  ]) {
    assert.equal(parseYouTubeId(input), 'dQw4w9WgXcQ', input);
  }
  assert.throws(() => parseYouTubeId('https://vimeo.com/123456789'), /Not a YouTube video/);
});

test('key resolution', () => {
  assert.equal(resolveKey(' Back '), 'KEY_RETURN');
  assert.equal(resolveKey('7'), 'KEY_7');
  assert.equal(resolveKey('key_source'), 'KEY_SOURCE');
  assert.throws(() => resolveKey('rm -rf'), /Unknown key/);
});
