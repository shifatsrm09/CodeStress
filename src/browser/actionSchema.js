export const actionNames = ['navigate', 'goBack', 'reload', 'click', 'fill', 'select', 'check', 'uncheck', 'press', 'upload', 'wait', 'screenshot', 'getPage', 'getDOM', 'getVisibleText', 'getLinks', 'getButtons', 'getInputs', 'getURL'];
const targetKeys = ['role', 'name', 'label', 'text', 'placeholder', 'testId', 'css'];
export function validateTarget(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target) || Object.keys(target).some(key => !targetKeys.includes(key))) throw new Error('Invalid element target');
  if (!['role', 'label', 'text', 'placeholder', 'testId', 'css'].some(key => typeof target[key] === 'string' && target[key].length > 0 && target[key].length <= 250)) throw new Error('An element locator is required');
  if (target.role && (!target.name || typeof target.name !== 'string')) throw new Error('Role needs an accessible name');
  for (const value of Object.values(target)) if (typeof value !== 'string' || value.length > 250) throw new Error('Invalid locator');
  return target;
}
export function validateAction(value) {
  if (!value || !actionNames.includes(value.action) || Object.keys(value).some(key => !['action', 'target', 'url', 'value', 'key', 'fileId', 'ms'].includes(key))) throw new Error('Invalid action');
  const result = { ...value };
  if (['click', 'fill', 'select', 'check', 'uncheck', 'press', 'upload'].includes(value.action)) validateTarget(value.target);
  if (value.action === 'navigate' && (typeof value.url !== 'string' || value.url.length > 2048)) throw new Error('Invalid URL');
  if (['fill', 'select'].includes(value.action) && (typeof value.value !== 'string' || value.value.length > 4000)) throw new Error('Invalid field value');
  if (value.action === 'press' && !['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'Space'].includes(value.key)) throw new Error('Unsupported key');
  if (value.action === 'upload' && (typeof value.fileId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value.fileId))) throw new Error('Unknown fixture reference');
  if (value.action === 'wait' && (!Number.isInteger(value.ms) || value.ms < 0 || value.ms > 3000)) throw new Error('Wait exceeds limit');
  return result;
}
export const dangerousText = /delete|destroy|remove|payment|purchase|checkout|charge|transfer|send|invite|email|publish|integrat|webhook|logout|sign.?out/i;
export function actionRisk(action, descriptor = {}) {
  if (dangerousText.test([action.url, descriptor.name, descriptor.href, descriptor.formAction, action.target?.name, action.target?.text].filter(Boolean).join(' '))) return 'DANGEROUS';
  if (action.action === 'click' && descriptor.tag === 'a' && descriptor.href) return 'SAFE';
  return ['click', 'fill', 'select', 'check', 'uncheck', 'press', 'upload'].includes(action.action) ? 'CAUTION' : 'SAFE';
}
