// Pure app-server notification -> hub event payloads; no state or I/O.
export function translate(method, p) {
  switch (method) {
    case 'item/agentMessage/delta': return [{ kind: 'message.delta', itemId: p.itemId, text: p.delta }];
    case 'item/reasoning/summaryTextDelta': return [{ kind: 'reasoning.delta', itemId: p.itemId, text: p.delta }];
    case 'turn/plan/updated': return [{ kind: 'plan.updated', plan: p.plan }];
    case 'error': return [{ kind: 'error', message: p.error.message }];
    case 'item/started': return p.item.type === 'commandExecution'
      ? [{ kind: 'command.started', itemId: p.item.id, command: p.item.command }] : [];
    case 'item/completed': {
      const i = p.item;
      switch (i.type) {
        case 'reasoning': return [{ kind: 'reasoning.done', itemId: i.id }];
        case 'agentMessage': return [{ kind: 'message.done', itemId: i.id, text: i.text }];
        case 'commandExecution': return [{ kind: 'command.done', itemId: i.id, exitCode: i.exitCode ?? null }];
        case 'fileChange': return i.status === 'completed' ? i.changes.map(c => ({ kind: 'file.changed', path: c.path })) : [];
        case 'imageGeneration': return [{ kind: 'image.generated', path: i.savedPath ?? null }];
      }
    }
  }
  return [];
}
