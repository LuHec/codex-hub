// Fake sessions and a scripted event stream, for trying the TUI without a hub.

export function startDemo(model, redraw) {
  const now = Date.now();
  let seq = 0;
  const sessions = [
    session("a1f3c2", "pelican on a bicycle", "gpt-6-astra", "high", { harness: "demo", id: "7e21" }, "running", now - 250_000, "E:\\Codes\\Projects\\pelican-bicycle"),
    session("b7d019", "codex-hub backend", "gpt-6-astra", "high", { harness: "demo", id: "7e21" }, "running", now - 740_000, "E:\\Codes\\Projects\\codex-hub"),
    session("c33e80", "lighthouse rework", "gpt-6-astra", "xhigh", { harness: "demo", id: "19ab" }, "idle", now - 3_600_000, "E:\\Codes\\Projects\\blender-scene", 2, "Rework done; the gold reflection is still too regular."),
    session("d02b5e", "haiku", "gpt-6.1-sol", "low", { harness: "demo", id: "19ab" }, "idle", now - 7_200_000, "C:\\Temp\\live-test", 2, "Appended the bicycle haiku to haiku.txt."),
    session("e9a4f7", "browser smoke test", "gpt-6.1-sol", "medium", null, "failed", now - 90_000_000, "E:\\Codes\\Projects\\browser-test", 1, "Browser permission was declined.")
  ];
  model.setSessions(sessions);

  const emit = (sessionId, ev) => {
    model.apply({ seq: ++seq, ts: Date.now(), sessionId, ...ev });
    redraw();
  };
  const touch = (s, patch) => {
    Object.assign(s, patch, { lastActivityAt: Date.now() });
    emit(s.id, { kind: "session.updated", session: s });
  };

  // History for idle sessions.
  const hist = (s, prompt, msg, cmds, status = "completed") => {
    emit(s.id, { kind: "turn.started", prompt, by: s.owner });
    for (const c of cmds) {
      emit(s.id, { kind: "command.started", itemId: c, command: c });
      emit(s.id, { kind: "command.done", itemId: c, exitCode: status === "failed" ? 1 : 0 });
    }
    emit(s.id, { kind: "message.done", itemId: prompt, text: msg });
    emit(s.id, { kind: "turn.completed", status, error: status === "failed" ? "The user declined permission for this action" : undefined });
  };
  hist(sessions[2], "Rework: make it beautiful. Dusk gradient sky, island centered, lamp clearly lit.", "Rework done and re-rendered. Biggest remaining gap: the gold reflection is more regular than in C.png.", [
    "'D:/steamlibrary/steamapps/common/Blender/blender.exe' -b -P scene.py"
  ]);
  hist(sessions[3], "Append a three-line bicycle haiku to haiku.txt", "Appended the bicycle haiku and read the file back: six lines, both poems intact.", [
    "Add-Content -LiteralPath 'haiku.txt' -Value 'wheels chase the dawn'"
  ]);
  hist(sessions[4], "Open example.com in the browser and take a screenshot", "Browser permission was declined; no title or screenshot.", ["cua.createBrowserTab('https://example.com')"], "failed");

  // Live script for the two running sessions.
  const pel = sessions[0];
  const hub = sessions[1];
  emit(pel.id, { kind: "turn.started", prompt: "Make an SVG illustration of a pelican riding a bicycle. Concept image first, then hand-write the SVG.", by: pel.owner });
  emit(hub.id, { kind: "turn.started", prompt: "Build the hub and CLI described in PROTOCOL.md.", by: hub.owner });
  touch(hub, {
    plan: [
      { step: "Read PROTOCOL.md and app-server prior art", status: "completed" },
      { step: "Hub: app-server lifecycle + session state", status: "completed" },
      { step: "Event normalization + jsonl persistence", status: "inProgress" },
      { step: "CLI + client.mjs", status: "pending" },
      { step: "Two-session smoke test with steer", status: "pending" }
    ],
    lastLine: "wiring item/agentMessage/delta → message.delta"
  });

  const script = [
    [pel, { kind: "reasoning.delta", itemId: "r1", text: "Plan the pose first: seat, pedals and bars must line up." }, "planning the pose"],
    [pel, { kind: "message.delta", itemId: "m1", text: "I'll generate a concept image first, " }],
    [pel, { kind: "message.delta", itemId: "m1", text: "then hand-write the SVG and render it to check feet, pedals and handlebars line up." }, "generating the concept image"],
    [hub, { kind: "command.started", itemId: "h1", command: '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "node --check src/server.mjs"' }, "$ node --check src/server.mjs"],
    [pel, { kind: "image.generated", path: "E:\\Codes\\Projects\\pelican-bicycle\\concept.png" }, "concept.png generated"],
    [hub, { kind: "command.done", itemId: "h1", exitCode: 0 }],
    [pel, { kind: "file.changed", path: "E:\\Codes\\Projects\\pelican-bicycle\\pelican.svg" }, "✎ pelican.svg"],
    [hub, { kind: "steer", text: "Keep the event shapes exactly as PROTOCOL.md — the TUI depends on them.", by: { harness: "demo", id: "7e21" } }, "steer received"],
    [hub, { kind: "message.delta", itemId: "m2", text: "Understood — keeping event shapes exact. Moving on to the CLI." }, "moving on to the CLI"],
    [pel, { kind: "command.started", itemId: "p2", command: "node render.mjs pelican.svg pelican.png" }, "$ node render.mjs pelican.svg pelican.png"],
    [pel, { kind: "command.done", itemId: "p2", exitCode: 0 }],
    [pel, { kind: "message.done", itemId: "m3", text: "Done. Best part: the beak and pouch read instantly. Weakest: the far leg is mostly hidden by the frame." }, "done"],
    [pel, { kind: "turn.completed", status: "completed" }, null, { status: "idle", turns: 1, turnStartedAt: null }]
  ];
  // Play the script once; afterwards the demo sits still like a quiet hub would.
  let i = 0;
  const timer = setInterval(() => {
    if (i >= script.length) return clearInterval(timer);
    const [s, ev, line, patch] = script[i];
    emit(s.id, ev);
    if (line || patch) touch(s, { ...(line ? { lastLine: line } : {}), ...(patch ?? {}) });
    i++;
  }, 1400);
}

function session(id, title, model, effort, owner, status, createdAt, cwd, turns = 0, lastMessage = null) {
  return {
    id,
    title,
    cwd,
    model,
    effort,
    owner,
    status,
    createdAt,
    turnStartedAt: status === "running" ? createdAt : null,
    lastActivityAt: status === "running" ? Date.now() : createdAt,
    lastLine: lastMessage ?? "",
    plan: [],
    turns,
    lastMessage
  };
}
