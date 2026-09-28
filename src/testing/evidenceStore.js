import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
export class EvidenceStore {
  constructor(directory, redactor) { this.directory = directory; this.redactor = redactor; }
  async save(observation, session) {
    await fs.mkdir(this.directory, { recursive: true });
    const id = randomUUID(), record = this.redactor.clean({ ...observation, evidenceId: id });
    if (session) {
      try { await session.screenshot(path.join(this.directory, `${id}.png`)); record.screenshot = `${id}.png`; }
      catch { record.screenshotError = 'Screenshot unavailable or sensitive page excluded.'; }
    }
    await fs.writeFile(path.join(this.directory, `${id}.json`), JSON.stringify(record, null, 2), { mode: 0o600 });
    return record;
  }
}
