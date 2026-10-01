# codex-hub protocol 1

One local service owns one `codex app-server`. Independent harnesses and TUIs share
its sessions. The package has no harness discovery or integration dependencies.

## Transport and handshake

- Newline-delimited JSON over a local named pipe or Unix socket.
- Default endpoint: Windows `\\.\pipe\codex-hub-<username>`; otherwise
  `$XDG_RUNTIME_DIR/codex-hub.sock` or `/tmp/codex-hub-<uid>.sock`.
  `CODEX_HUB_ENDPOINT` overrides it. `CODEX_HUB_HOME` overrides `~/.codex-hub`.
- Request: `{ "id": 1, "method": "session.list", "params": {} }`.
  Response: `{ "id": 1, "result": ... }` or `{ "id": 1, "error": { "code", "message", ... } }`.
  Push after subscribe: `{ "event": ... }`.
- First request: `hello { protocol: 1, client: "cli" | "tui", owner?: Owner }`.
  Result: `{ protocol: 1, version: string, pid: number }`. Identity is fixed for
  the connection; repeat hello returns `INVALID_PARAMS`.
- An unsupported protocol returns `PROTOCOL_MISMATCH` with the instruction
  **run `codex-hub hub restart` when idle**. Clients also reject old servers whose
  hello response omits the protocol. Missing/wrong-type fields are `INVALID_PARAMS`.
- All methods require hello except `hub.stop`, which remains available for
  recovery from a version mismatch. Stop/restart are local maintenance operations
  and do not require an owner. Restart stops the server, waits for disconnect,
  then auto-starts the server from the client's own package.
- Ordinary clients auto-start their own package's server when unreachable.
  `hub status` and `hub stop` never auto-start. Requests are never retried after a
  disconnect. A disconnected wait resolves only on the server side; the client
  rejects outstanding RPCs.

## Strict parameters and errors

Every method has one declared parameter spec, mutation flag and handler in
`src/protocol.mjs`. Unknown fields (including nested owner fields), missing
required fields, null in place of optional values, wrong types, empty strings,
negative/fractional counters and non-boolean flags return `INVALID_PARAMS` naming
the field. Optional fields must be omitted, not set to null. All string params
must be nonempty after trimming; their original contents are retained.
`cwd` and each `dirs` entry must name an existing directory and are resolved to
absolute paths. Unknown methods return `NOT_FOUND`.

| Code | Meaning |
|---|---|
| `INVALID_PARAMS` | Invalid field, frame, repeat hello or empty configure |
| `NOT_FOUND` | Unknown method or session |
| `AMBIGUOUS_ID` | Session prefix matches more than one session |
| `BUSY` | A turn is already running |
| `NOT_RUNNING` | Steer needs a running turn |
| `OWNER_REQUIRED` | Missing identity for a session mutation, or hello not sent |
| `OWNER_MISMATCH` | Another harness owns the session; intentional takeover needs force |
| `PROTOCOL_MISMATCH` | Client/server protocol differs |
| `HUB_STOPPING` | Shutdown has begun |
| `CODEX_ERROR` | App-server request/process failure, preserving its message |

Ownership errors also carry `sessionId`, `title`, `owner` and `caller`; absent
values are null. `owner` and `caller` are objects, never display strings.

## Identity and ownership

```ts
Owner = { harness: string, id: string }
```

`harness` matches `[a-z][a-z0-9_-]*`; `id` is nonempty and contains no whitespace.
IDs may contain colons. The hub validates shape only, never defaults or interprets
harness values. CLI/TUI environment syntax is `CODEX_HUB_OWNER=harness:id`, split
at the first colon. No other environment variable supplies identity. An unset
variable gives a read-only CLI; an empty or malformed value is rejected locally.
`ls --mine` compares both fields. Labels display `harness:id`; TUI abbreviates
only the ID to four characters.

- Non-TUI create and all six session mutations require an owner, even with force.
  Create takes identity from hello; there is no per-request owner override.
- Different harnesses need `force: true`. Same-harness callers pass and normally
  preserve the existing owner. Force transfers to the caller, even within the
  same harness. Unowned sessions are adopted on successful mutation.
- Check the current owner, perform the operation, then transfer and persist in
  the same per-session queue. Failed mutations and idle interrupts do not transfer.
- TUI mutations always pass the owner gate and never change ownership. TUI create
  uses its hello owner or null. Normal running-turn and parameter checks still apply.
- Reads, including wait, do not require an owner and never transfer ownership.
- Identity and client type are self-declared. **The gate prevents mistakes, not
  attacks; this is not authentication.** Use only as a local service.

## Methods

`id` accepts a full session ID or unique prefix. `force`, `network` are booleans;
`dirs` is a string array; `afterSeq`, `limit`, `timeoutMs`, `replay` are nonnegative
safe integers. Other params are strings except hello's owner and protocol.

| Method | Params | Result |
|---|---|---|
| `hello` | `{ protocol: 1, client: "cli" \| "tui", owner? }` | `{ protocol, version, pid }` |
| `hub.stop` | `{}` | `{}` then shutdown |
| `subscribe` | `{ replay? }` | `{ sessions: Session[], seq }` then events |
| `session.create` | `{ cwd, prompt, title?, model?, effort?, dirs?, network?, sandbox? }` | Session, first turn started |
| `session.list` | `{ owner?: Owner }` | Visible Session[] by newest activity |
| `session.get` | `{ id }` | Session, including archived |
| `session.events` | `{ id, afterSeq?, limit? }` | Event[] |
| `session.wait` | `{ id, timeoutMs? }` | Session when not running or timeout |
| `session.send` | `{ id, prompt, model?, effort?, force? }` | Session, next turn started |
| `session.steer` | `{ id, text, force? }` | `{}` |
| `session.interrupt` | `{ id, force? }` | `{}`, idle is a no-op |
| `session.configure` | `{ id, model?, effort?, dirs?, network?, sandbox?, force? }` | Session, applies next turn |
| `session.rename` | `{ id, title, force? }` | Session |
| `session.archive` | `{ id, force? }` | `{}`, hides session but retains files |

Sandbox is `danger-full-access` (existing default) or `workspace-write` (writes
inside cwd + dirs, network controlled by `network`, default false). Approvals are
`never`. Configure requires at least one setting; dirs replaces the whole list.
A sandbox change unloads/re-resumes the thread on the next send.

Models and efforts come from Codex's [`model/list`](https://learn.chatgpt.com/docs/app-server#list-models-modellist),
fetched once per startup (following pagination, including hidden models).
Explicit values are checked against `model` and `supportedReasoningEfforts`.
New sessions use the catalog's default model (or first model) and its default
effort. Changing model without effort uses that model's default effort.
If discovery fails, is empty, or a page exceeds five seconds, validation passes
through and omitted values are delegated to Codex. There is no hard-coded catalog.
An unavailable model at inference time still produces Codex's error.

## Session state and storage v2

```ts
Session = {
  id: string            // Codex thread id
  title: string         // short label; defaults to first line of first prompt
  cwd: string
  dirs: string[]        // extra writable directories (absolute)
  network: boolean      // outbound network for commands
  sandbox: "workspace-write" | "danger-full-access"  // default danger-full-access
  archived?: true
  model: string | null  // effective Codex model
  effort: string | null // effective effort, null when delegated to Codex
  owner: Owner | null   // null means unowned
  status: "idle" | "running" | "failed" | "interrupted"
  createdAt: number     // ms epoch
  turnStartedAt: number | null
  lastActivityAt: number
  lastLine: string      // latest one-line human-readable activity, for list views
  plan: { step: string, status: "pending" | "inProgress" | "completed" }[]
  turns: number         // completed turn count
  lastMessage: string | null  // final agent message of the last completed turn
}
```

`state.json` is `{ version: 2, seq, sessions, archived }`, replaced atomically.
Events live in `sessions/<id>.jsonl`. The storage loader migrates v1 owners once:
`a:b` becomes `{harness:"a", id:"b"}`; a bare legacy ID becomes
`{harness:"claude", id:<ID>}` (the sole historical compatibility assumption);
null stays null. Subsequent loads retain v2 objects. Historical journal owners
are converted when read; journals are not compacted or rewritten. A torn final
journal row is truncated. Newer journal snapshots recover sessions missing from
or newer than state.json; global event sequence never goes backwards.

Running sessions reload as interrupted; other sessions reload as idle. Turns do
not survive restart. The next send resumes the persisted Codex thread. Sessions
have separate mutation queues; reads wait for preceding mutations. Wait never
holds the mutation queue. Steer sends the current expected turn ID to Codex.

## Events

```ts
Event = { seq: number, ts: number, sessionId: string } & (
  | { kind: "session.created", session: Session }
  | { kind: "session.updated", session: Session }      // any Session field change (archive sets archived: true); live only
  | { kind: "turn.started", prompt: string, by: Owner | null }
  | { kind: "turn.completed", status: "completed" | "failed" | "interrupted", error?: string }
  | { kind: "message.delta", itemId: string, text: string }      // live only
  | { kind: "message.done", itemId: string, text: string }
  | { kind: "reasoning.delta", itemId: string, text: string }    // summary only; live only
  | { kind: "reasoning.done", itemId: string, text: string }
  | { kind: "command.started", itemId: string, command: string }
  | { kind: "command.done", itemId: string, exitCode: number | null }
  | { kind: "file.changed", path: string }
  | { kind: "image.generated", path: string | null }
  | { kind: "plan.updated", plan: Session["plan"] }
  | { kind: "steer", text: string, by: Owner | null }
  | { kind: "error", message: string }
)
```


Deltas and session.updated are live only. Completed or interrupted items settle
into one journaled message.done/reasoning.done event. session.events combines
journaled events and unsettled live deltas. afterSeq is exclusive; with a cursor,
limit pages forward, otherwise it selects the latest N. Omitted limit returns
all; zero returns none. turn counts include completed, failed and interrupted
turns. Retrying Codex errors are activity and do not end a turn.

Subscribe returns its snapshot before delivering replay/live events. Replay is
last N per visible session, globally sorted. Deduplicate by seq; historical
snapshots at or below the response's seq must not replace the current snapshot.
Archive emits session.updated with archived=true, so live views can remove it.

## CLI

Run `codex-hub --help` for commands. `--json` writes raw results to stdout and
structured errors to stderr. Request failures exit 1. Wait exits 0 for idle, 1
for failed, interrupted or a timeout returning running; timeout never interrupts.
Closing a controller does not stop its turn. Use `hub restart` only when idle.
