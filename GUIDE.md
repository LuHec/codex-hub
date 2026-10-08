# Working with Codex through codex-hub

For an agent that leads and hands implementation to Codex. Print it any time with `codex-hub guide`.

Codex does the implementing here. How the work is split between you, the user and Codex is decided with the user each time; these are notes on working with Codex.

Codex is strong at implementation but weak at architecture and framework design, and it tends to over-build. Its reports on its own work run optimistic, so check results yourself, especially anything visual.

When you hand Codex a task, give it what it can't work out on its own and leave out what it can: the goal and why it matters, the design decisions already made, the constraints that matter, pointers to the relevant code or a way to reproduce, what is required versus optional, and how to tell it's done. Don't spell out steps. For larger work, have it show a plan or concept images first and check them against the agreed design. Codex follows stop rules literally, so write boundaries as intent ("use the official pipeline, don't hand-edit the rig") rather than "stop and report if X". When it hits a snag the agreed plan already answers, decide it and keep the work moving, with a safeguard such as a backup when a step is hard to undo.

## Commands

For an independent economy worker, use `codex-hub new --backend dsh --cwd <dir>
--model deepseek-flash --prompt-file <brief>`. This creates a DSH session, not a
Codex session; it never changes backends. Follow up with the same send/wait/stop
commands. DSH has no steer: stop first, then send. Its model/effort choices come
from DSH, and its own execution policy replaces the Codex sandbox flags.
The TUI marks DSH sessions and offers new-session creation with `n`.

Codex sessions run in a shared hub. The user watches them live with `codex-hub tui`. Your harness sets `CODEX_HUB_OWNER=<harness>:<conversation id>` so your sessions are marked as yours.

- `codex-hub new --cwd <dir> --model <model> --effort <effort> --title <short title> --prompt-file <brief>` starts a session and prints its id.
- `codex-hub wait <id>` blocks until the turn ends. Run it in a background shell if your harness has one, so you are woken when Codex finishes.
- `codex-hub send <id> --prompt-file <f>` starts a follow-up turn. `steer <id> "<text>"` redirects a running turn. `stop <id>` interrupts it.
- `codex-hub config <id> --model <m> --effort <e>` changes the model or effort from the next turn.
- Sessions run with full access by default. Pass `--no-full-access` to sandbox one (writes only inside `--cwd` plus any `--dir`; `--network` for internet).
- `codex-hub ls --mine`, `codex-hub show <id> --events N` inspect sessions.
- A session another harness started fails with `OWNER_MISMATCH`. Check you have the right session; take it over with `--force` only when you mean to.

Use `gpt-6-astra` for hard or visual work and `gpt-6.1-sol` for routine work.

DeepSeek V4.1 Flash (DSV4.1F, `--backend dsh --model deepseek-flash`) is a secondary, lower-cost model; give it clear, complete instructions.

GLM-5.3 (`--backend dsh --model glm-5.3`, provider `zai`) is a high-performance coding-only model. It does not support image recognition; give it text and source code. Start it with `codex-hub new --backend dsh --cwd <dir> --model glm-5.3 --prompt-file <brief>`; follow up with the same wait/send/stop commands.
