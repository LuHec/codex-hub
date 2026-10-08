// The hub supplies display-ready choices; the TUI does not interpret backend protocols.
export function loadModels(session) {
  return structuredClone(session?.modelOptions ?? []);
}
