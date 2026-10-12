import swedish from './messages-sv.mjs';
import english from './messages-en.mjs';

export const translations = { 'sv-SE': swedish, 'en-US': english };
export const languageOptions = [
  { name: 'Svenska / Swedish — sv-SE', value: 'sv-SE' },
  { name: 'English / Engelska — en-US', value: 'en-US' },
  { name: 'Automatic / Automatiskt — auto', value: 'auto' },
];
export function normalizeLanguage(value) {
  if (typeof value !== 'string') return null;
  const aliases = { sv: 'sv-SE', 'sv-se': 'sv-SE', en: 'en-US', 'en-us': 'en-US', auto: 'auto' };
  return aliases[value.trim().toLowerCase()] ?? null;
}
export function resolveLanguage(locale, override) {
  const explicit = normalizeLanguage(override);
  if (explicit && explicit !== 'auto') return explicit;
  return typeof locale === 'string' && /^sv(?:-|$)/i.test(locale) ? 'sv-SE' : 'en-US';
}
export function text(language, key, values = {}) {
  const value = (translations[language] ?? english)[key];
  if (value === undefined) throw new Error('Missing translation: ' + key);
  return (Array.isArray(value) ? value.join('\n') : value).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
}
export function autocompleteLanguages(query) {
  const selected = String(query ?? '').trim().toLowerCase();
  return languageOptions.filter(option => option.name.toLowerCase().includes(selected));
}
