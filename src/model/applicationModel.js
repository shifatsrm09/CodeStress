import { AppError } from '../core/runtime.js';
export const modelFields = ['purpose', 'technology', 'routes', 'pages', 'apiEndpoints', 'uiActions', 'forms', 'entities', 'workflows', 'userRoles', 'permissions', 'authentication', 'businessRules', 'validations', 'redirects', 'protectedResources', 'relationships', 'testing'];
export function sourceReferences(value, repository) {
  if (!Array.isArray(value) || !value.length || value.length > 12) return false;
  return value.every(ref => {
    const file = repository.files.find(file => file.path === ref?.file);
    return file && Number.isInteger(ref.line) && ref.line > 0 && typeof ref.quote === 'string' && ref.quote.trim().length >= 5 && file.content.split('\n')[ref.line - 1]?.includes(ref.quote);
  });
}
export function validateModel(data, repository) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Model must be an object');
  const result = { version: 1, coverage: repository.coverage, unknowns: Array.isArray(data.unknowns) ? data.unknowns.filter(x => typeof x === 'string').slice(0, 30) : [] };
  for (const field of modelFields) {
    if (!Array.isArray(data[field]) || data[field].length > 50) throw new Error('Invalid model field');
    result[field] = data[field].map(item => {
      if (!item || typeof item.description !== 'string' || item.description.length > 1200 || !['confirmed', 'inferred', 'uncertain'].includes(item.status) || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1 || !sourceReferences(item.sourceEvidence, repository)) throw new Error('Ungrounded model fact');
      // Source citations confirm source existence, never runtime correctness.
      return { description: item.description, status: item.status === 'confirmed' ? 'inferred' : item.status, confidence: Math.min(item.confidence, 0.95), sourceEvidence: item.sourceEvidence };
    });
  }
  return result;
}
export async function buildApplicationModel(provider, repository, report) {
  if (!report.chunkNotes.some(note => note.complete)) throw new AppError('NO_UNDERSTANDING', 'No completed source findings are available. Browser testing has not started.');
  const batches = []; let current = [], size = 0; let oversized = 0;
  for (const note of report.chunkNotes.filter(note => note.complete)) {
    const file = repository.files.find(file => file.path === note.path);
    if (!file) continue;
    const item = { finding: note, source: file.content.split('\n').slice(note.startLine - 1, note.endLine).map((line, i) => `${note.startLine + i}: ${line}`).join('\n') };
    const length = JSON.stringify(item).length;
    if (length > 28000) { oversized++; continue; }
    if (size + length > 28000 && current.length) { batches.push(current); current = []; size = 0; }
    current.push(item); size += length;
  }
  if (current.length) batches.push(current);
  const model = Object.fromEntries(modelFields.map(field => [field, []]));
  model.version = 1; model.coverage = report.aiCoverage; model.unknowns = [];
  for (const batch of batches.slice(0, 12)) {
    const part = await provider.structuredGenerate(`Build an application model from these findings and exact source excerpts. Return an object with these array fields: ${modelFields.join(', ')}, plus unknowns (string array). Each item: {description:string,status:"inferred|uncertain",confidence:number 0..1,sourceEvidence:[{file,line,quote}]}. All evidence must quote the exact unnumbered source line. Empty arrays are allowed. Existing tests are expectations, not proof. Extract purpose, routes, UI actions/forms, entities, workflows, roles, permissions, validations, state transitions and invariants where supported. At most 12 items per field. Never claim runtime confirmation.`, { findings: batch }, value => validateModel(value, repository));
    for (const field of modelFields) model[field].push(...part[field]);
    model.unknowns.push(...part.unknowns);
  }
  if (oversized) model.unknowns.push(`${oversized} oversized source findings were excluded from the model context budget.`);
  let retained = 0;
  for (const field of modelFields) {
    const seen = new Set();
    model[field] = model[field].filter(item => {
      const key = JSON.stringify(item.sourceEvidence) + item.description;
      if (seen.has(key)) return false;
      seen.add(key);
      const length = JSON.stringify(item).length;
      if (retained + length > 60000) { model.unknowns.push('Model detail exceeded the planning context budget; additional findings remain in source notes.'); return false; }
      retained += length; return true;
    });
  }
  model.unknowns = [...new Set(model.unknowns)].slice(0, 40);
  if (batches.length > 12) model.unknowns.push('Application model budget: later source findings were not modeled.');
  if (!repository.coverage.complete || !report.aiCoverage.complete) model.unknowns.push('Source or AI coverage is incomplete.');
  return model;
}
