# codex-hub

A standalone local service for multiple harnesses to drive Codex through one
`codex app-server`. Node.js 22+, an authenticated Codex installation, no npm
dependencies. Private package, installed locally; never published.

From the repository root:

```sh
npm install -g ./packages/codex-hub
```

Set `CODEX_HUB_OWNER=harness:conversation-id` in the controller's environment.
PowerShell: `$env:CODEX_HUB_OWNER = 'myharness:conversation-1'`.
Ownerless CLI connections can inspect sessions. Malformed identities fail locally.

```sh
codex-hub new --cwd /path/to/project --title "Small task" --prompt-file task.txt
codex-hub ls --mine
codex-hub wait <id>
codex-hub send <id> "Continue with the next step"
codex-hub steer <id> "Focus on the failing test"
codex-hub stop <id>
codex-hub show <id> --events 20
codex-hub tui
codex-hub hub status
codex-hub hub restart   # when idle
codex-hub hub stop
```

Model/effort defaults and valid choices come from Codex. Sessions default to full
access; `--no-full-access` selects workspace-write, with `--dir` for extra writable
directories and `--network` for network access. `config` changes the next turn.
`--force` explicitly takes over another harness's session after success. The TUI
can operate on any session without changing its owner. This gate prevents
accidents; it is not authentication.

Ordinary commands auto-start the server from this package. `hub status` and
`hub stop` never start one. `node packages/codex-hub/src/server.mjs` runs it in the
foreground. Binary selection: `CODEX_BIN`, newest Windows desktop Codex binary,
then `codex` on PATH. `CODEX_BIN` is an unquoted executable path without arguments.

State defaults to `~/.codex-hub`, diagnostics to `hub.log` in that directory.
For isolation set **both** `CODEX_HUB_ENDPOINT` and `CODEX_HUB_HOME`.
Restart interrupts active turns; the next send resumes the stored thread.
Wait can run in a harness's background shell while another connection steers it.

## Client API

```js
import { HubClient } from 'codex-hub';

const hub = await new HubClient({
  client: 'cli', owner: { harness: 'myharness', id: 'conversation-1' }
}).connect();
const { sessions, seq } = await hub.subscribe(event => console.log(event), { replay: 20 });
await hub.request('session.list');
hub.close();
```

`HubClient` is the only export. Options: endpoint, autoStart (default true),
startTimeoutMs (default 30000), client (default cli), owner (optional object).
It does not read owner environment variables. unsubscribe(callback) removes a
listener; close rejects pending requests. Reconnect and resubscribe explicitly.
The maintenance-only option allowProtocolMismatch keeps a connection open to
send hub.stop during restart; ordinary connections reject incompatible servers.
The full contract is [PROTOCOL.md](PROTOCOL.md).

## Development and verification

`npm test` from the repo root runs unit/integration tests with fake Codex processes.
`npm run test:smoke --prefix packages/codex-hub` exercises real inference, all basic
CLI commands and the TUI, using the dedicated Windows pipe
`\\.\pipe\codex-hub-standalone-test` and a temporary home. It saves report.json and
tui.ansi in the printed temp directory and stops its hub/app-server afterward.
`npm run test:live --prefix packages/codex-hub` additionally tests two simultaneous
controllers, steering and file-producing turns. Run live tests separately; they
share the dedicated test pipe on Windows. Neither invokes a global hub command.
