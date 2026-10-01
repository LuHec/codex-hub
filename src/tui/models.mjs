// Models and reasoning efforts the local Codex offers, from its own models cache.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function loadModels() {
  try {
    const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
    const cache = JSON.parse(fs.readFileSync(path.join(home, "models_cache.json"), "utf8"));
    const models = (cache.models ?? [])
      .filter((m) => m.visibility !== "hide")
      .map((m) => ({
        slug: m.slug,
        efforts: (m.supported_reasoning_levels ?? []).map((l) => l.effort ?? l).filter(Boolean),
        def: m.default_reasoning_level
      }))
      .filter((m) => m.slug && m.efforts.length);
    return models;
  } catch {
    return [];
  }
}
