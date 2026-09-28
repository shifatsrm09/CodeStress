import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Redactor } from '../core/redaction.js';

const digest = value => createHash('sha256').update(value).digest('hex');
export const memoryRoot = path.resolve('.codestress', 'memory');
export function projectKey(source, target) {
  return digest(JSON.stringify([source.location, new URL(target).origin]));
}
export function sourceFingerprint(repository, model) {
  return digest(JSON.stringify([2, model, repository.coverage, repository.files.map(file => [file.path, file.sha256]).sort()]));
}
export function redactMemory(value, secrets) {
  if (typeof value === 'string') {
    for (const secret of secrets) value = value.split(secret).join('[redacted]');
    return value;
  }
  if (typeof value === 'number' && secrets.includes(String(value))) return '[redacted]';
  if (Array.isArray(value)) return value.map(item => redactMemory(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactMemory(item, secrets)]));
  return value;
}
export class ProjectMemory {
  constructor(key, secrets = [], redactor = new Redactor(secrets)) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid project memory key.');
    this.directory = path.join(memoryRoot, key);
    this.redactor = redactor; this.pending = Promise.resolve();
    this.secrets = secrets.filter(value => typeof value === 'string' && value.length > 2);
    this.state = { version: 1, notes: [], status: 'new' };
  }
  async load() {
    try {
      const data = JSON.parse(await fs.readFile(path.join(this.directory, 'memory.json'), 'utf8'));
      if (data.version === 1 && Array.isArray(data.notes)) this.state = { ...data, notes: data.notes.filter(note => note && typeof note.path === 'string' && typeof note.note === 'string') };
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw new Error('Project memory could not be read.'); }
    return this.state;
  }
  save(update) {
    const operation = this.pending.catch(() => {}).then(() => this.write(update));
    this.pending = operation; return operation;
  }
  async write(update) {
    this.state = { ...this.state, ...update, updatedAt: new Date().toISOString() };
    const serialized = JSON.stringify(this.redactor.clean(redactMemory(this.state, this.secrets)), null, 2);
    await fs.mkdir(this.directory, { recursive: true });
    const temporary = path.join(this.directory, `${randomUUID()}.tmp`);
    await fs.writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, path.join(this.directory, 'memory.json'));
  }
}
