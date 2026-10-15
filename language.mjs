import german from './messages-de.mjs';
import french from './messages-fr.mjs';
import spanish from './messages-es.mjs';
import chinese from './messages-zh.mjs';
import swedish from './messages-sv.mjs';
import english from './messages-en.mjs';

export const translations = { 'sv-SE': swedish, 'en-US': english, de: german, fr: french, 'es-ES': spanish, 'zh-CN': chinese };
export const languageOptions = [
  { name: 'Deutsch / German — de', value: 'de' },
  { name: 'Français / French — fr', value: 'fr' },
  { name: 'Español / Spanish — es-ES', value: 'es-ES' },
  { name: '简体中文 / Chinese — zh-CN', value: 'zh-CN' },
  { name: 'Svenska / Swedish — sv-SE', value: 'sv-SE' },
  { name: 'English / Engelska — en-US', value: 'en-US' },
  { name: 'Automatic / Automatiskt — auto', value: 'auto' },
];
export function normalizeLanguage(value) {
  if (typeof value !== 'string') return null;
  const aliases = { de: 'de', 'de-de': 'de', fr: 'fr', 'fr-fr': 'fr', es: 'es-ES', 'es-es': 'es-ES', zh: 'zh-CN', 'zh-cn': 'zh-CN', 'zh-tw': 'zh-CN', sv: 'sv-SE', 'sv-se': 'sv-SE', en: 'en-US', 'en-us': 'en-US', auto: 'auto' };
  return aliases[value.trim().toLowerCase()] ?? null;
}
export function resolveLanguage(locale, override) {
  const explicit = normalizeLanguage(override);
  if (explicit && explicit !== 'auto') return explicit;
  return normalizeLanguage(locale) ?? normalizeLanguage(typeof locale === 'string' ? locale.split('-')[0] : null) ?? 'en-US';
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
