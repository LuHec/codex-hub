# codex-hub

A standalone local service for multiple harnesses to drive Codex or DeepSeek
Harness (DSH). Each backend runs in its own process and starts on demand.
Node.js 22+, an authenticated Codex installation for Codex sessions, no npm
dependencies. Private package, installed locally; never published.

```sh
npm install -g <path to this repository>
```

## Automatic setup

On a new Windows computer, authenticate GitHub CLI for access to this private
repository, then run:

```powershell
gh repo clone LuHec/codex-hub
cd codex-hub
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

The installer installs Node.js LTS through winget if Node.js 22+ is missing,
installs the global Hub, installs its own pinned DSH runtime, and configures the
ACP profile with DeepSeek and Z.ai. Existing `~/.dsh/.credentials.yaml` is referenced
using this computer's path. No keys are copied or included in the repository.
Existing profile settings are preserved; running the installer again is supported.
If there are no existing credentials, set `DEEPSEEK_API_KEY` and/or `ZAI_API_KEY`
in the launching environment before starting the Hub.

With Node.js already installed, `codex-hub setup` (or `npm run setup` in the repository) configures DSH on Windows, macOS
and Linux. It installs DSH under `~/.codex-hub/dsh/runtime`; `DSH_BIN` still overrides
runtime selection. Restart an existing Hub when idle after setup.

## Integrating a harness

codex-hub is the only official piece; each harness writes its own thin adapter.
An adapter does two things and needs no code:

1. Set `CODEX_HUB_OWNER=<harness>:<conversation id>` in the agent's environment,
   e.g. from a session-start hook. `<harness>` is a lowercase name of your choosing.
2. Teach the agent to use the hub: point it at `codex-hub guide` (the
   [shared guide](GUIDE.md) on working with Codex and the commands), plus anything
   specific to your harness.

Depend only on the CLI and [PROTOCOL.md](PROTOCOL.md); see its compatibility promise.

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
`hub stop` never start one. `node src/server.mjs` runs it in the
foreground. Binary selection: `CODEX_BIN`, newest Windows desktop Codex binary,
then `codex` on PATH. `CODEX_BIN` is an unquoted executable path without arguments.

State defaults to `~/.codex-hub`, diagnostics to `hub.log` in that directory.
For isolation set **both** `CODEX_HUB_ENDPOINT` and `CODEX_HUB_HOME`.
Restart interrupts active turns; the next send resumes the stored thread.
Wait can run in a harness's background shell while another connection steers it.

## DSH sessions

Run the automatic installer or `npm run setup` (`DSH 0.1.5-rc.1` tested).
The hub launches its installed DSH runtime with `--profile acp`;
`DSH_BIN` can name an executable, `.cmd`, or the CLI's `lib/bin.js` file.
Set `DEEPSEEK_API_KEY` in the hub's launch environment, or configure credentials
in its DSH home: `<CODEX_HUB_HOME>/dsh` (normally `~/.codex-hub/dsh`).
`CODEX_HUB_DSH_HOME` overrides that directory. The desktop DSH profile is not used.

```sh
codex-hub new --backend dsh --cwd /path/to/project --model deepseek-flash "Run the focused tests"
codex-hub send <id> "Continue"
codex-hub stop <id>
```

Omitting `--backend` creates a Codex session. DSH sessions carry a separate `dsh`
object with their native id and ACP configuration options; existing Codex records
keep their shape. There is no backend setting on an existing session.
DSH errors stay with DSH. A failure in either process leaves the other backend usable.

DSH supports follow-up turns, cancellation, restart/resume, generic tool records,
and model/effort selection from its advertised options. Its default model comes
from the ACP profile; `--model deepseek-flash` explicitly selects the economy model.

GLM-5.3 (`--model glm-5.3`, provider `zai`) is a high-performance coding-only
model. It does not support image recognition; give it text and source code.

The hub answers owned DSH permission requests with `allow_once` when available.
DSH uses its own execution policy: `--dir`, `--network` and `--no-full-access`
are unsupported. It has no steering operation; stop, then send the next prompt.
ACP text arrives at committed-message boundaries, not token by token.
Each committed text block is journaled immediately as a cumulative message snapshot,
so live display, history and restart preserve the same message/tool ordering.

In the TUI, **n** creates a session: choose `codex` or `dsh`, enter the workspace,
then the task. **Ctrl+U** clears an input. Lists and focus headers identify the
backend. **p** or **/model** opens that backend's model choices. After choosing a
different DSH model, reopen **/effort** to see its supported efforts. **Esc** stops
a running task; typing into a running DSH session preserves the draft until it stops.

`npm run test:dsh:smoke` checks the installed DSH's handshake, create, model
configuration, close and resume after process restart, using a temporary DSH home.
It makes no inference request. The ordinary tests use an isolated fake ACP process
and also exercise the TUI keyboard flow.

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

The hub composes `Codex` (over the existing `AppServer` transport), `Dsh`, `Sessions`
and `Store` explicitly. Both backends own protocol state, model configuration,
resume and event translation. They receive copied records and return patches or
normalized events; only `Sessions` writes shared session state. The TUI consumes
display-ready model choices, with no dependency on either execution module.
Hub shutdown always closes clients and releases its lock even when a backend
reports a shutdown error; the original failure still reaches the caller.

`npm test` runs unit/integration tests with fake Codex processes.
`npm run test:smoke` exercises real inference, all basic
CLI commands and the TUI, using the dedicated Windows pipe
`\\.\pipe\codex-hub-standalone-test` and a temporary home. It saves report.json and
tui.ansi in the printed temp directory and stops its hub/app-server afterward.
`npm run test:live` additionally tests two simultaneous
controllers, steering and file-producing turns. Run live tests separately; they
share the dedicated test pipe on Windows. Neither invokes a global hub command.
