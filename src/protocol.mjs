import fs from 'node:fs';
import path from 'node:path';

export const PROTOCOL = 1;
export const fault = (code, message, details = {}) => Object.assign(new Error(message), { code, ...details });
const invalid = (field, expected) => { throw fault('INVALID_PARAMS', `${field} ${expected}`); };
const string = (v, field) => { if (typeof v !== 'string' || !v.trim()) invalid(field, 'must be a nonempty string'); };
const integer = (v, field) => { if (!Number.isSafeInteger(v) || v < 0) invalid(field, 'must be a nonnegative integer'); };
const boolean = (v, field) => { if (typeof v !== 'boolean') invalid(field, 'must be a boolean'); };
const choice = values => (v, field) => { if (!values.includes(v)) invalid(field, `must be one of: ${values.join(', ')}`); };
const optional = check => ({ check, optional: true });
const owner = (v, field) => {
  validate(v, { harness: string, id: string }, field);
  if (!/^[a-z][a-z0-9_-]*$/.test(v.harness)) invalid(`${field}.harness`, 'must be a lowercase identifier');
  if (/\s/.test(v.id)) invalid(`${field}.id`, 'must not contain whitespace');
};
const dirs = (v, field) => {
  if (!Array.isArray(v)) invalid(field, 'must be an array');
  v.forEach((d, i) => string(d, `${field}[${i}]`));
};
export function directory(value, field) {
  const absolute = path.resolve(value);
  try { if (fs.statSync(absolute).isDirectory()) return absolute; } catch { /* Report the field. */ }
  invalid(field, 'must name an existing directory');
}
export function validate(params, spec, prefix = '') {
  if (!params || typeof params !== 'object' || Array.isArray(params)) invalid(prefix || 'params', 'must be an object');
  const name = key => prefix ? `${prefix}.${key}` : key;
  for (const key of Object.keys(params)) if (!Object.hasOwn(spec, key)) invalid(name(key), 'is unknown');
  for (const [key, rule] of Object.entries(spec)) {
    if (!Object.hasOwn(params, key) && rule.optional) continue;
    (rule.check ?? rule)(params[key], name(key));
  }
}
const tuning = { model: optional(string), effort: optional(string) };
const access = { dirs: optional(dirs), network: optional(boolean), sandbox: optional(choice(['workspace-write', 'danger-full-access'])) };
const target = { id: string };
const mutation = { ...target, force: optional(boolean) };
const method = (params, mutation, handler) => ({ params, mutation, handler });
export const methods = {
  hello: method({ protocol: integer, client: choice(['cli', 'tui']), owner: optional(owner) }, false, (h, p, c) => h.hello(c, p)),
  'hub.stop': method({}, true, h => { setImmediate(() => void h.stop()); return {}; }),
  subscribe: method({ replay: optional(integer) }, false, (h, p, c) => h.subscribe(c, p)),
  'session.create': method({ cwd: string, prompt: string, title: optional(string), ...tuning, ...access }, true, (h, p, c) => h.create(p, c)),
  'session.list': method({ owner: optional(owner) }, false, (h, p) => h.list(p.owner)),
  'session.get': method(target, false, (h, p, c, s) => structuredClone(s)),
  'session.events': method({ ...target, afterSeq: optional(integer), limit: optional(integer) }, false, (h, p, c, s) => h.events(s.id, p.afterSeq, p.limit)),
  'session.wait': method({ ...target, timeoutMs: optional(integer) }, false, (h, p, c, s) => h.wait(s, p.timeoutMs, c)),
  'session.send': method({ ...mutation, prompt: string, ...tuning }, true, (h, p, c, s) => h.startTurn(s, p, c.identity.owner)),
  'session.steer': method({ ...mutation, text: string }, true, (h, p, c, s) => h.steer(s, p, c.identity.owner)),
  'session.interrupt': method(mutation, true, (h, p, c, s) => h.interrupt(s)),
  'session.configure': method({ ...mutation, ...tuning, ...access }, true, (h, p, c, s) => h.configure(s, p)),
  'session.rename': method({ ...mutation, title: string }, true, (h, p, c, s) => h.rename(s, p)),
  'session.archive': method(mutation, true, (h, p, c, s) => h.archive(s)),
};
