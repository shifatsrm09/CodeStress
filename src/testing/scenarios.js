import { sourceReferences } from '../model/applicationModel.js';
import { validateAction, validateTarget } from '../browser/actionSchema.js';
export const categories = ['functional', 'validation', 'authorization', 'authentication', 'navigation', 'error-handling', 'regression'];
export function validateExpectation(value) {
  if (!value || !['url', 'text', 'visible', 'hidden', 'httpStatus', 'inputValidity', 'noPageErrors'].includes(value.type)) throw new Error('Unsupported expectation');
  if (['url', 'text'].includes(value.type) && (typeof value.value !== 'string' || !value.value.length || value.value.length > 1000)) throw new Error('Expectation requires a value');
  if (['visible', 'hidden', 'inputValidity'].includes(value.type)) validateTarget(value.target);
  if (value.type === 'inputValidity' && typeof value.valid !== 'boolean') throw new Error('Expected validity is required');
  if (value.type === 'httpStatus' && (typeof value.path !== 'string' || !value.path.startsWith('/') || !Array.isArray(value.statuses) || !value.statuses.length || value.statuses.some(status => !Number.isInteger(status) || status < 100 || status > 599))) throw new Error('Expected HTTP statuses are required');
  return value;
}
export function validateScenarios(data, repository, max = 5) {
  if (!Array.isArray(data) || data.length < 1 || data.length > max) throw new Error('Generate between one and five meaningful tests');
  const ids = new Set();
  return data.map(item => {
    if (!item || !/^TEST-\d{3}$/.test(item.id) || ids.has(item.id) || typeof item.name !== 'string' || !item.name || item.name.length > 160 || !categories.includes(item.category) || !['high', 'medium', 'low'].includes(item.priority) || !['SAFE', 'CAUTION', 'DANGEROUS'].includes(item.risk)) throw new Error('Invalid test metadata');
    if (!['anonymous', 'authenticated'].includes(item.session) || !Array.isArray(item.preconditions) || item.preconditions.some(x => typeof x !== 'string') || !Array.isArray(item.steps) || !item.steps.length || item.steps.length > 15 || !Array.isArray(item.expected) || !item.expected.length || item.expected.length > 8 || !sourceReferences(item.sourceEvidence, repository)) throw new Error('Invalid or ungrounded scenario');
    ids.add(item.id);
    if (item.category === 'authorization' && item.session === 'authenticated' && (typeof item.requiredRole !== 'string' || !item.requiredRole)) throw new Error('Authorization tests require an explicit role');
    return { id: item.id, name: item.name, category: item.category, priority: item.priority, risk: item.risk, session: item.session, requiredRole: typeof item.requiredRole === 'string' ? item.requiredRole : null, preconditions: item.preconditions, steps: item.steps.map(validateAction), expected: item.expected.map(validateExpectation), sourceEvidence: item.sourceEvidence };
  });
}
export async function generateScenarios(provider, model, repository, saved = [], uploadIds = []) {
  const instruction = `Generate 3–5 meaningful application behavior tests from this source model (fewer only if evidence is insufficient). Return a JSON array. Each test: {id:"TEST-001",name,category:"${categories.join('|')}",priority:"high|medium|low",risk:"SAFE|CAUTION|DANGEROUS",session:"anonymous|authenticated",preconditions:string[],steps:Action[],expected:Expectation[],sourceEvidence:[{file,line,quote}]}.
Action: {action:"navigate",url:"/source-backed-path"} or {action:"click|fill|select|check|uncheck|press",target:{role,name} OR {label} OR {text} OR {placeholder} OR {testId} OR {css},value?:string,key?:"Enter|Tab|Escape|ArrowDown|ArrowUp|Space"}. Upload action: {action:"upload",target:locator,fileId:string}, only with a supplied uploadIds entry; upload is CAUTION. Never output JavaScript. Do not include credentials. Prefer meaningful functional and validation flows, not generic security checklists. Never assume a route containing admin implies a normal user is authorized or forbidden. For authenticated authorization scenarios set requiredRole to the source-backed role; execution will require that role in verified identity evidence. Unknown roles/fixtures are explicit preconditions, not facts. Use a known fixture account for ownership comparisons; do not invent resource IDs.
Expectation: {type:"url|text",value:string} (url is exact path; text is a literal substring), {type:"visible|hidden",target:locator}, {type:"httpStatus",path:string,statuses:number[]}, {type:"inputValidity",target:locator,valid:boolean}, {type:"noPageErrors"}. Preserve exact cited source quotes from the model. Expected values must be grounded in those sources. API methods that mutate data and form actions are CAUTION; delete/payment/email/external integrations are DANGEROUS. Previous successful scenarios may inform regression cases but must be revalidated.`;
  return provider.structuredGenerate(instruction, { model, uploadIds, previousSuccessfulTests: saved.slice(0, 5) }, value => validateScenarios(value, repository));
}
