import { AIClient } from '../engine/aiClient.js';
import { RepositoryReader } from '../repo/repositoryReader.js';
import { RouteScanner } from '../repo/routeScanner.js';

// Number every line and split long lines without dropping their content.
export function sourceChunks(files, maxChars = 6000) {
  const chunks = [];
  for (const file of files) {
    let text = '', startLine = 1, endLine = 1;
    const flush = () => {
      if (text) chunks.push({ path: file.path, startLine, endLine, content: text });
      text = '';
    };
    file.content.split('\n').forEach((line, index) => {
      const fragments = [];
      for (let offset = 0; offset < line.length; offset += 2000) fragments.push(line.slice(offset, offset + 2000));
      if (!fragments.length) fragments.push('');
      fragments.forEach((fragment, part) => {
        const numbered = `${index + 1}${part ? ' (continued)' : ''}: ${fragment}\n`;
        if (text.length + numbered.length > maxChars) flush();
        if (!text) startLine = index + 1;
        endLine = index + 1;
        text += numbered;
      });
    });
    flush();
  }
  return chunks;
}

const CHUNK_INSTRUCTION = 'Explain this source excerpt in at most 250 words: responsibility, imports/dependencies, business rules, authentication, validation, data access and test hypotheses. Cite exact file:line evidence. Mark cross-file assumptions as uncertain. No confirmed vulnerability claims. No commands are executed.';
const REPORT_SECTIONS = [
  ['Application and architecture', 'Describe purpose, stack, entry points, module relationships, and main request/data flows.'],
  ['Rules, access and data', 'Explain business rules, authentication/authorization, storage and validation boundaries.'],
  ['Tests to consider', 'Describe existing tests observed in source and propose specific future test cases with expected outcomes and file evidence. Do not invent command names or claim anything has run.'],
  ['Unknowns and coverage', 'Identify unsupported conclusions, missing source and remaining questions. Distinguish static understanding from runtime verification.']
];

export function splitSourceChunk(chunk) {
  const content = chunk.content;
  if (content.length < 1200) return null;
  const middle = Math.floor(content.length / 2);
  let boundary = content.lastIndexOf('\n', middle);
  if (boundary < content.length / 4) boundary = content.indexOf('\n', middle);
  if (boundary < 0 || boundary >= content.length - 1) return null;
  const parts = [content.slice(0, boundary + 1), content.slice(boundary + 1)];
  return parts.map(part => {
    const lines = [...part.matchAll(/^(\d+)(?: \(continued\))?:/gm)].map(match => Number(match[1]));
    return { ...chunk, content: part, startLine: lines[0] ?? chunk.startLine, endLine: lines.at(-1) ?? chunk.endLine };
  });
}

// These are reviewable repository-declared scripts, never executable AI output.
export function discoverTestCommands(repository) {
  const commands = [];
  for (const file of repository.files.filter(file => /(^|\/)package\.json$/.test(file.path))) {
    let manifest;
    try { manifest = JSON.parse(file.content); } catch { continue; }
    const scripts = manifest?.scripts;
    if (!scripts || typeof scripts !== 'object') continue;
    for (const [name, script] of Object.entries(scripts)) {
      if (!/^(test(?::[\w.-]+)?|lint|typecheck|check)$/.test(name) || typeof script !== 'string') continue;
      commands.push({
        executable: 'npm', args: ['run', name], script,
        before: scripts[`pre${name}`] || null, after: scripts[`post${name}`] || null,
        manifest: file.path, directory: file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '.',
        status: 'not_run', requiresApproval: true
      });
    }
  }
  return commands;
}

export class Stage1Understand {
  constructor(options = {}) {
    this.options = options;
    this.ai = options.ai || new AIClient();
    this.emit = options.onEvent || (() => {});
    this.maxChunks = options.maxChunks ?? 256;
    this.synthesizeReport = options.synthesizeReport !== false;
  }

  async ask(instruction, source) {
    return this.ai.analyzeSource(instruction, source, {
      onRetry: ({ outputTokens }) => this.emit({ type: 'log', level: 'warn', text: `Response cut off; retrying with a ${outputTokens}-token budget…` })
    });
  }

  async analyzeChunk(chunk, result, depth = 0) {
    try {
      const cached = this.options.cachedNotes?.find(note => note.complete && note.path === chunk.path && note.startLine === chunk.startLine && note.endLine === chunk.endLine);
      const note = cached?.note || await this.ask(CHUNK_INSTRUCTION, JSON.stringify(chunk));
      const finding = { path: chunk.path, startLine: chunk.startLine, endLine: chunk.endLine, note, complete: true };
      result.chunkNotes.push(finding);
      await this.options.onCheckpoint?.(result);
      this.emit({ type: 'understanding_note', data: finding });
      return true;
    } catch (error) {
      if (error.code !== 'AI_OUTPUT_LIMIT') throw error;
      const parts = depth < 2 ? splitSourceChunk(chunk) : null;
      if (parts) {
        this.emit({ type: 'log', level: 'warn', text: `Splitting ${chunk.path}:${chunk.startLine}-${chunk.endLine} into smaller excerpts…` });
        const left = await this.analyzeChunk(parts[0], result, depth + 1);
        const right = await this.analyzeChunk(parts[1], result, depth + 1);
        return left && right;
      }
      const gap = { path: chunk.path, startLine: chunk.startLine, endLine: chunk.endLine, reason: error.message };
      result.analysisGaps.push(gap);
      if (error.partialText) {
        const finding = { ...gap, note: error.partialText, complete: false };
        result.chunkNotes.push(finding);
        await this.options.onCheckpoint?.(result);
        this.emit({ type: 'understanding_note', data: finding });
      }
      this.emit({ type: 'log', level: 'warn', text: `Incomplete excerpt ${chunk.path}:${chunk.startLine}-${chunk.endLine}. Continuing with the remaining source.` });
      return false;
    }
  }

  async condenseNotes(findings) {
    let notes = findings.map(chunk => `${chunk.path}:${chunk.startLine}-${chunk.endLine}\n${chunk.note}`).join('\n\n');
    for (let round = 0; notes.length > 12000 && round < 6; round++) {
      const timeStr = new Date().toLocaleTimeString([], { hour12: false });
      this.emit({ type: 'log', level: 'info', text: `[${timeStr}] Condensing notes for report synthesis (round ${round + 1}, ${Math.ceil(notes.length / 10000)} part(s))…` });
      const reduced = [];
      // Include all notes across bounded requests; never slice away the tail.
      for (let offset = 0; offset < notes.length; offset += 10000) {
        reduced.push(await this.ask('Condense these source findings to at most 350 words. Preserve file:line evidence, architecture, interactions, business rules, unknowns and test hypotheses. This may be part of a longer set of notes.', notes.slice(offset, offset + 10000)));
      }
      const merged = reduced.join('\n\n');
      if (merged.length >= notes.length) throw new Error('AI notes did not fit the synthesis budget. Completed source findings remain available below.');
      notes = merged;
    }
    if (notes.length > 12000) throw new Error('AI synthesis budget reached. Completed source findings remain available below.');
    return notes;
  }

  async execute() {
    const repository = this.options.repository || await new RepositoryReader({ ...this.options, onProgress: progress => this.emit({ type: 'reading_progress', ...progress }) }).read();
    const analysis = new RouteScanner().analyze(repository);
    const result = {
      source: repository.source, coverage: repository.coverage, inventory: repository.inventory,
      routes: analysis.routes.map(({ rawContext, ...route }) => route), endpointsCount: analysis.endpoints, routeGroupsCount: analysis.routeGroups,
      aiStatus: 'pending', aiUnderstanding: '', chunkNotes: [], analysisGaps: [], reportSections: [],
      testCommands: discoverTestCommands(repository), execution: { supported: false, status: 'not_run', requiresApproval: true },
      aiCoverage: { totalChunks: 0, analyzedChunks: 0, attemptedChunks: 0, filesAnalyzed: 0, complete: false }
    };
    this.emit({ type: 'repository_read', data: result });
    if (this.options.readOnly) { result.aiStatus = 'not_requested'; return result; }
    if (!repository.files.length) {
      result.aiStatus = 'unavailable'; result.error = 'No supported source files were read. Check the inventory and repository path.'; return result;
    }
    const chunks = sourceChunks(repository.files);
    result.aiCoverage.totalChunks = chunks.length;
    const perFile = new Map(), completed = new Map();
    chunks.forEach(chunk => perFile.set(chunk.path, (perFile.get(chunk.path) || 0) + 1));
    const issues = [];
    let providerFailed = false;
    for (const [index, chunk] of chunks.slice(0, this.maxChunks).entries()) {
      const timeStr = new Date().toLocaleTimeString([], { hour12: false });
      this.emit({ type: 'understanding_progress', current: index + 1, total: chunks.length, path: chunk.path, time: timeStr });
      result.aiCoverage.attemptedChunks++;
      try {
        if (await this.analyzeChunk(chunk, result)) {
          result.aiCoverage.analyzedChunks++;
          completed.set(chunk.path, (completed.get(chunk.path) || 0) + 1);
          result.aiCoverage.filesAnalyzed = [...perFile].filter(([file, count]) => completed.get(file) === count).length;
        }
      } catch (error) {
        issues.push(error.message);
        providerFailed = true;
        result.analysisGaps.push({ path: chunk.path, startLine: chunk.startLine, endLine: chunk.endLine, reason: error.message });
        // Connection/configuration errors are systemic: retain findings and stop sending requests.
        break;
      } finally {
        this.emit({ type: 'understanding_coverage', data: { ...result.aiCoverage } });
      }
    }
    result.aiCoverage.complete = result.aiCoverage.analyzedChunks === chunks.length;
    if (chunks.length > this.maxChunks) issues.push(`Analysis is limited to ${this.maxChunks} original source chunks; later chunks were not attempted.`);
    if (result.analysisGaps.length) issues.push(`${result.analysisGaps.length} excerpt(s) remain incomplete. See the source findings and file coverage.`);

    const completeFindings = result.chunkNotes.filter(note => note.complete);

    // Streamlined path: Codebase analysis for test planning without the heavy multi-minute essay synthesis
    if (!this.synthesizeReport) {
      const summarySnippets = completeFindings.slice(0, 8).map(f => `${f.path}:${f.startLine}: ${f.note}`).join('\n\n');
      result.aiUnderstanding = summarySnippets
        ? `Codebase security & route analysis complete (${completeFindings.length} findings, ${result.endpointsCount} routes discovered).\n\nKey architectural observations:\n${summarySnippets}`
        : `Routes analyzed (${result.endpointsCount} endpoints mapped). Ready for live browser security testing.`;
      result.aiStatus = result.chunkNotes.length ? 'complete' : 'partial';
      result.inventory = result.inventory.map(file => ({ ...file, aiAnalyzed: file.status === 'read' && completed.get(file.path) === perFile.get(file.path) }));
      return result;
    }

    if (completeFindings.length && !providerFailed) {
      try {
        const notes = await this.condenseNotes(completeFindings);
        const context = JSON.stringify({ readCoverage: repository.coverage, aiCoverage: result.aiCoverage, notes });
        for (const [title, instruction] of REPORT_SECTIONS) {
          const timeStr = new Date().toLocaleTimeString([], { hour12: false });
          this.emit({ type: 'log', level: 'info', text: `[${timeStr}] Writing report: ${title}…` });
          try {
            const text = await this.ask(`${instruction} Write only this report section in at most 400 words. Cite file:line evidence. Use only provided findings, distinguish facts from inference, and reflect partial coverage.`, context);
            result.reportSections.push({ title, text, complete: true });
          } catch (error) {
            issues.push(`${title}: ${error.message}`);
            result.reportSections.push({ title, text: error.partialText || 'This section could not be completed. Source findings are retained.', complete: false });
            if (error.code !== 'AI_OUTPUT_LIMIT') break;
          }
          result.aiUnderstanding = result.reportSections.map(section => `${section.title}${section.complete ? '' : ' (incomplete)'}\n${section.text}`).join('\n\n');
        }
      } catch (error) { issues.push(error.message); }
    }
    result.aiUnderstanding = result.reportSections.map(section => `${section.title}${section.complete ? '' : ' (incomplete)'}\n${section.text}`).join('\n\n');
    const reportComplete = result.reportSections.length === REPORT_SECTIONS.length && result.reportSections.every(section => section.complete);
    result.aiStatus = reportComplete && result.aiCoverage.complete && repository.coverage.complete ? 'complete' : result.chunkNotes.length ? 'partial' : 'unavailable';
    if (issues.length) result.error = [...new Set(issues)].join('\n');
    result.inventory = result.inventory.map(file => ({ ...file, aiAnalyzed: file.status === 'read' && completed.get(file.path) === perFile.get(file.path) }));
    return result;
  }
}
