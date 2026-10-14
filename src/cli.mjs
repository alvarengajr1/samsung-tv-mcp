#!/usr/bin/env node
// Entry point. With no arguments it runs the MCP server over stdio (what MCP clients launch).
// `discover`, `pair` and `status` are for setting things up from a terminal.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import os from 'node:os';
import { join } from 'node:path';
import { SamsungTV } from './tv.mjs';
import { createServer } from './mcp.mjs';

const env = process.env;
const list = (value) => (value ? value.split(',').map((s) => s.trim()).filter(Boolean) : undefined);

const tv = new SamsungTV({
  dataDir: env.SAMSUNG_TV_DATA_DIR || join(os.homedir(), '.samsung-tv-mcp'),
  host: env.SAMSUNG_TV_HOST || undefined,
  extraApps: list(env.SAMSUNG_TV_EXTRA_APPS) ?? [],
  subnets: list(env.SAMSUNG_TV_SUBNET),
});

const print = (data) => console.log(JSON.stringify(data, null, 2));
const command = process.argv[2];

if (!command) {
  const server = createServer(tv, { maxVolume: Number(env.SAMSUNG_TV_MAX_VOLUME) || 50 });
  await server.connect(new StdioServerTransport());
  // stdout belongs to the MCP protocol; anything human-readable goes to stderr.
  console.error(`samsung-tv-mcp ready (TV: ${tv.config.ip || 'not found yet'}, data: ${tv.configFile})`);
} else if (command === 'discover') {
  const device = await tv.discover();
  print(device ? { found: true, ip: tv.config.ip, name: device.name, model: device.modelName } : { found: false });
} else if (command === 'pair') {
  if (!tv.config.ip && !(await tv.discover())) {
    console.error('No TV found. Set SAMSUNG_TV_HOST or SAMSUNG_TV_SUBNET.');
    process.exit(1);
  }
  console.error('Accept the "samsung-tv-mcp" request on the TV screen (30 s)...');
  try {
    print(await tv.pair({ force: process.argv.includes('--force') }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    tv.close();
  }
} else if (command === 'status') {
  print(await tv.state());
  tv.close();
} else {
  console.error('Usage: samsung-tv-mcp [discover | pair [--force] | status]');
  process.exit(2);
}
