# samsung-tv-mcp

An [MCP](https://modelcontextprotocol.io) server that lets AI agents control a Samsung Tizen smart TV on your local
network: power, volume, remote keys, text input, apps and YouTube videos.

```text
You:    put lo-fi beats on the living room TV, not too loud
Claude: tv_status → standby
        tv_power {on: true}
        tv_play_youtube {video: "jfKfPfyJRdk"}
        tv_set_volume {level: 15}
```

It talks to the TV directly over its local APIs. No cloud account, no SmartThings, no hub.

## Tools

| Tool | What it does |
| --- | --- |
| `tv_status` | Power (`on` / `standby` / `off`), name, model, IP, paired, volume, mute. Finds the TV again if DHCP moved it. |
| `tv_power` | On (Wake-on-LAN, then the power key if it stays in standby) or off. Idempotent. |
| `tv_press_keys` | Remote keys in order, using aliases (`up`, `ok`, `back`, `home`, `play`, `0`–`9`…) or raw `KEY_*` codes. |
| `tv_set_volume` | Absolute volume over DLNA, refused above a configurable cap. |
| `tv_type_text` | Fills the text field open on screen (search boxes). |
| `tv_list_apps` | Installed apps with their Tizen IDs. |
| `tv_launch_app` | Opens an app by name (`"prime"`) or ID. Ambiguous or unknown names come back as errors that list the options. |
| `tv_play_youtube` | Opens YouTube on a video, from a URL (`watch`, `youtu.be`, `shorts`, `embed`) or an ID. |
| `tv_pair` | Shows the "Allow" pop-up on the TV and waits for it to be accepted. |

Errors are returned as tool results (`isError`) with a stable code (`not_paired`, `tv_off`, `bad_request`) and a
message the model can act on, rather than thrown, so the agent can recover by itself: pair, turn the TV on, or pick
another app. The server also sends MCP `instructions` describing that flow.

### Guardrails

An agent holding a TV remote should not be able to blast the volume at 3 a.m.

- `tv_set_volume` refuses levels above `SAMSUNG_TV_MAX_VOLUME` (default 50).
- `tv_press_keys` allows at most 5 `volume_up` per call, so the cap cannot be bypassed with keys, and at most 30 keys.
- `KEY_POWER` is not accepted as a key; power goes through `tv_power`, which checks the current state first, so
  "turn it on" never turns an already-on TV off.
- `tv_status` and `tv_list_apps` are annotated `readOnlyHint`, so clients can auto-approve them and ask before the rest.

## Setup

Requires Node.js 20+ and a Samsung TV from 2016 or later on the same network.

```bash
git clone https://github.com/<you>/samsung-tv-mcp && cd samsung-tv-mcp
npm install
npx samsung-tv-mcp discover   # scans your /24 and remembers the TV
npx samsung-tv-mcp pair       # accept the pop-up on the TV with the physical remote
npx samsung-tv-mcp status
```

The IP, MAC and pairing token are stored in `~/.samsung-tv-mcp/`.

### Claude Code

```bash
claude mcp add samsung-tv -- node /path/to/samsung-tv-mcp/src/cli.mjs
```

### Claude Desktop and other MCP clients

```json
{
  "mcpServers": {
    "samsung-tv": {
      "command": "node",
      "args": ["/path/to/samsung-tv-mcp/src/cli.mjs"],
      "env": { "SAMSUNG_TV_MAX_VOLUME": "40" }
    }
  }
}
```

### Configuration

| Variable | Default | |
| --- | --- | --- |
| `SAMSUNG_TV_HOST` | discovered | Fixed TV address; disables rescanning. |
| `SAMSUNG_TV_SUBNET` | from local interfaces | `/24` prefixes to scan, comma separated (`192.168.1`). |
| `SAMSUNG_TV_MAX_VOLUME` | `50` | Volume cap for `tv_set_volume`. |
| `SAMSUNG_TV_EXTRA_APPS` | | App IDs to probe besides the built-in catalog. |
| `SAMSUNG_TV_DATA_DIR` | `~/.samsung-tv-mcp` | Where the config and token live. |

## How it talks to the TV

| What | How |
| --- | --- |
| Keys and text | WebSocket `wss://TV:8002/api/v2/channels/samsung.remote.control` with a token from pairing |
| State, apps | REST on `http://TV:8001/api/v2/` |
| Volume and mute | UPnP/DLNA RenderingControl on port 9197, no token needed |
| YouTube video | DIAL `POST http://TV:8080/ws/apps/YouTube` with body `v=<id>` |
| Power on | Wake-on-LAN to the TV's MAC, then the power key if it is still in standby |

Things learned on a 2025 TV (UN43U8600F) that the older libraries and docs do not cover:

- **The app list request is ignored.** Newer TVs never answer `ed.installedApp.get` or `ed.apps.launch` over the
  WebSocket. They still answer `GET /api/v2/applications/<id>` one ID at a time, so the server probes a catalog of
  known IDs (`src/apps.mjs`) in parallel and keeps the ones the TV recognizes.
- **DIAL needs a YouTube `Origin`.** `POST /ws/apps/YouTube` answers 403 unless the request carries
  `Origin: https://www.youtube.com`.
- **Volume over DLNA is absolute and token-free**, which beats sending `KEY_VOLUP` twenty times.
- **A TV that turns off does not close the WebSocket.** The server drops the channel whenever the REST API stops
  answering, otherwise it would keep reporting "connected".
- **Standby swallows Wake-on-LAN** while the network stack is still up, so `tv_power` falls back to the power key.
- **There is no API to install apps.** None of the store IDs respond.

## Tests

```bash
npm test
```

The suite runs a fake TV (`test/fake-tv.mjs`) that serves the same REST, DLNA, DIAL and WebSocket endpoints on one
local port, including pairing approval, timeouts and revoked tokens. The MCP tests connect a real MCP client to the
server over an in-memory transport, so they cover the protocol layer, not just the TV client.

## Library use

```js
import { SamsungTV } from 'samsung-tv-mcp';

const tv = new SamsungTV({ dataDir: './data', host: '192.168.1.50' });
await tv.pair();
await tv.launchApp('3201907018807'); // Netflix
```

## License

MIT
