// MCP tools on top of SamsungTV. Each tool returns JSON text; failures come back as
// tool errors (isError) with a stable code so the model can decide what to do next.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { TvError } from './tv.mjs';

export const VERSION = '0.1.0';

// Friendly names the model can use instead of raw KEY_* codes.
export const KEY_ALIASES = {
  up: 'KEY_UP', down: 'KEY_DOWN', left: 'KEY_LEFT', right: 'KEY_RIGHT',
  ok: 'KEY_ENTER', enter: 'KEY_ENTER', select: 'KEY_ENTER',
  back: 'KEY_RETURN', exit: 'KEY_EXIT', home: 'KEY_HOME', menu: 'KEY_MENU',
  source: 'KEY_SOURCE', info: 'KEY_INFO', guide: 'KEY_GUIDE',
  play: 'KEY_PLAY', pause: 'KEY_PAUSE', stop: 'KEY_STOP',
  fast_forward: 'KEY_FF', rewind: 'KEY_REWIND',
  volume_up: 'KEY_VOLUP', volume_down: 'KEY_VOLDOWN', mute: 'KEY_MUTE',
  channel_up: 'KEY_CHUP', channel_down: 'KEY_CHDOWN',
  ...Object.fromEntries(Array.from({ length: 10 }, (_, d) => [String(d), `KEY_${d}`])),
};

const MAX_KEYS_PER_CALL = 30;
const MAX_VOLUME_STEPS_PER_CALL = 5;

export const resolveKey = (name) => {
  const key = KEY_ALIASES[name.trim().toLowerCase()] ?? name.trim().toUpperCase();
  if (!/^KEY_[A-Z0-9_]+$/.test(key)) throw new TvError('bad_request', `Unknown key "${name}"`);
  if (key === 'KEY_POWER') throw new TvError('bad_request', 'Use tv_power to turn the TV on or off');
  return key;
};

// Accepts a bare 11-character ID or the usual YouTube URL shapes.
export const parseYouTubeId = (input) => {
  const value = input.trim();
  if (/^[\w-]{11}$/.test(value)) return value;
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^(www|m|music)\./, '');
    const id =
      host === 'youtu.be'
        ? url.pathname.slice(1)
        : host === 'youtube.com'
          ? url.searchParams.get('v') ?? /^\/(shorts|embed|live)\/([\w-]{11})/.exec(url.pathname)?.[2]
          : null;
    if (id && /^[\w-]{11}$/.test(id.slice(0, 11))) return id.slice(0, 11);
  } catch {
    // not a URL
  }
  throw new TvError('bad_request', `Not a YouTube video: "${input}"`);
};

const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data ?? { ok: true }, null, 2) }] });

const run = (fn) => async (args) => {
  try {
    return ok(await fn(args));
  } catch (error) {
    const code = error instanceof TvError ? error.code : 'tv_off';
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: code, message: error.message }) }] };
  }
};

const INSTRUCTIONS = `Controls a Samsung Tizen smart TV on the local network.
Start with tv_status: power "off" means unreachable (use tv_power on), "standby" means asleep.
If paired is false, call tv_pair and ask the user to accept the pop-up on the TV.
Prefer tv_launch_app and tv_play_youtube over navigating menus with keys.
Volume is capped by the server; never try to get around the cap with repeated volume keys.`;

/**
 * @param {import('./tv.mjs').SamsungTV} tv
 * @param {{ maxVolume?: number, keyDelayMs?: number }} [options]
 */
export function createServer(tv, { maxVolume = 50, keyDelayMs = 150 } = {}) {
  const server = new McpServer({ name: 'samsung-tv', version: VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool(
    'tv_status',
    {
      title: 'TV status',
      description:
        'Power state (on | standby | off), name, model, IP, whether this server is paired, current volume and mute. ' +
        'Rediscovers the TV on the LAN if its address changed.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    run(() => tv.state()),
  );

  server.registerTool(
    'tv_power',
    {
      title: 'Turn TV on or off',
      description: 'Turns the TV on (Wake-on-LAN, then the power key if it stays in standby) or off. No-op if already in that state.',
      inputSchema: { on: z.boolean().describe('true = turn on, false = turn off') },
      annotations: { idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    run(async ({ on }) => {
      await tv.power(on);
      return { power: (await tv.state()).power };
    }),
  );

  server.registerTool(
    'tv_press_keys',
    {
      title: 'Press remote keys',
      description:
        'Presses remote-control keys in order. Use aliases (up, down, left, right, ok, back, home, menu, source, ' +
        'play, pause, stop, fast_forward, rewind, volume_up, volume_down, mute, channel_up, channel_down, 0-9) ' +
        `or raw Samsung codes like KEY_RED. Up to ${MAX_KEYS_PER_CALL} keys per call.`,
      inputSchema: {
        keys: z.array(z.string()).min(1).max(MAX_KEYS_PER_CALL).describe('Keys to press, in order'),
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    run(async ({ keys }) => {
      const codes = keys.map(resolveKey);
      const volumeSteps = codes.filter((k) => k === 'KEY_VOLUP').length;
      if (volumeSteps > MAX_VOLUME_STEPS_PER_CALL) {
        throw new TvError('bad_request', `At most ${MAX_VOLUME_STEPS_PER_CALL} volume_up per call; use tv_set_volume`);
      }
      for (const [i, key] of codes.entries()) {
        if (i) await new Promise((resolve) => setTimeout(resolve, keyDelayMs));
        await tv.key(key);
      }
      return { pressed: codes };
    }),
  );

  server.registerTool(
    'tv_set_volume',
    {
      title: 'Set volume',
      description: `Sets the absolute volume (0-100) over DLNA. Levels above ${maxVolume} are refused as a safety cap.`,
      inputSchema: { level: z.number().int().min(0).max(100) },
      annotations: { idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    run(async ({ level }) => {
      if (level > maxVolume) throw new TvError('bad_request', `Volume ${level} is above the cap of ${maxVolume}`);
      await tv.setVolume(level);
      return { volume: (await tv.audio()).volume };
    }),
  );

  server.registerTool(
    'tv_type_text',
    {
      title: 'Type text',
      description:
        'Replaces the content of the text field that is open on the TV (search boxes, keyboards). ' +
        'Open the field first; this does nothing if no keyboard is on screen.',
      inputSchema: { text: z.string().max(500) },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    run(async ({ text }) => {
      await tv.text(text);
      return { typed: text };
    }),
  );

  server.registerTool(
    'tv_list_apps',
    {
      title: 'List installed apps',
      description: 'Apps from the built-in catalog that are installed on this TV, with their IDs and whether they are running.',
      inputSchema: { refresh: z.boolean().optional().describe('Probe the TV again instead of using the cached list') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    run(({ refresh }) => tv.listApps({ refresh })),
  );

  server.registerTool(
    'tv_launch_app',
    {
      title: 'Open an app',
      description: 'Opens an installed app by name ("netflix", "prime video") or by its Tizen ID from tv_list_apps.',
      inputSchema: { app: z.string().min(1) },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    run(async ({ app }) => {
      const apps = await tv.listApps();
      const query = app.trim().toLowerCase();
      const exact = apps.filter((a) => a.id === app.trim() || a.name.toLowerCase() === query);
      const matches = exact.length ? exact : apps.filter((a) => a.name.toLowerCase().includes(query));
      // Some apps have several catalog IDs (regional builds); the TV only answers for the one it has.
      const names = [...new Set(matches.map((a) => a.name))];
      if (!matches.length) {
        throw new TvError('bad_request', `No installed app matches "${app}". Installed: ${apps.map((a) => a.name).join(', ')}`);
      }
      if (names.length > 1) throw new TvError('bad_request', `"${app}" is ambiguous: ${names.join(', ')}`);
      await tv.launchApp(matches[0].id);
      return { launched: matches[0] };
    }),
  );

  server.registerTool(
    'tv_play_youtube',
    {
      title: 'Play a YouTube video',
      description: 'Opens the TV YouTube app directly on a video (DIAL), given a YouTube URL or an 11-character video ID.',
      inputSchema: { video: z.string().min(11).describe('YouTube URL or video ID') },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    run(async ({ video }) => {
      const id = parseYouTubeId(video);
      await tv.youtube(id);
      return { playing: id };
    }),
  );

  server.registerTool(
    'tv_pair',
    {
      title: 'Pair with the TV',
      description:
        'Shows an "Allow" pop-up on the TV and waits up to 30 s for someone to accept it with the physical remote. ' +
        'Tell the user to look at the TV before calling. force=true discards the current token and pairs again.',
      inputSchema: { force: z.boolean().optional() },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    run(({ force }) => tv.pair({ force: Boolean(force) })),
  );

  return server;
}
