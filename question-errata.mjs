import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { dayMs, saveQuestionJson } from './question-sources.mjs';

export const rulesDifferencesUrl = 'https://games.tabony.net/forum/viewtopic.php?p=4#p4';
const sha = text => createHash('sha256').update(text).digest('hex');
const decode = text => text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, entity) => {
  if (entity[0] === '#') {
    const value = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : ' ';
  }
  return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[entity.toLowerCase()] ?? whole;
});
function div(html, opening) {
  const match = opening.exec(html); if (!match) throw new Error('Expected forum post missing.');
  const rest = html.slice(match.index + match[0].length);
  let depth = 1;
  for (const tag of rest.matchAll(/<\/?div\b[^>]*>/gi)) {
    depth += /^<\//.test(tag[0]) ? -1 : 1;
    if (!depth) return rest.slice(0, tag.index);
  }
  throw new Error('Incomplete forum post.');
}
const plain = html => decode(html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
  .replace(/<br\s*\/?\s*>|<\/(?:li|p)>/gi, ' ')
  .replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
function items(html) {
  const result = []; let depth = 0, start;
  for (const tag of html.matchAll(/<\/?li\b[^>]*>/gi)) {
    if (!/^<\//.test(tag[0])) { if (depth++ === 0) start = tag.index + tag[0].length; }
    else if (--depth === 0) result.push(plain(html.slice(start, tag.index)));
    if (depth < 0) throw new Error('Invalid forum list.');
  }
  if (depth || !result.length || result.some(text => text.length < 8 || text.length > 6000)) throw new Error('Invalid forum differences.');
  return result;
}
export function extractRulesDifferences(html, capturedAt) {
  if (typeof html !== 'string' || Buffer.byteLength(html) > 250000) throw new Error('Invalid forum page.');
  const post = div(html, /<div\b[^>]*\bid=["']p4["'][^>]*>/i);
  if (!/class=["']username["'][^>]*>Logitude<\/a>/i.test(post)) throw new Error('Unexpected forum author.');
  const content = div(post, /<div\b[^>]*\bclass=["']content["'][^>]*>/i);
  const official = /<strong\b[^>]*>Known differences from the official rules:<\/strong>/i.exec(content);
  const legacy = /<strong\b[^>]*>Known differences from MaBiWeb(?:'|&#039;|&apos;)s rules implementation:<\/strong>/i.exec(content);
  if (!official || !legacy || official.index >= legacy.index) throw new Error('Forum sections missing.');
  const sections = [
    { id: 'official', title: 'Known differences from the official rules', entries: items(content.slice(official.index + official[0].length, legacy.index)) },
    { id: 'mabiweb', title: "Known differences from MaBiWeb's rules implementation", entries: items(content.slice(legacy.index + legacy[0].length)) },
  ];
  return validateRulesDifferences({ schemaVersion: 1, url: rulesDifferencesUrl, author: 'Logitude', capturedAt, sections, sha256: sha(JSON.stringify(sections)) });
}
export function validateRulesDifferences(data) {
  if (data?.schemaVersion !== 1 || data.url !== rulesDifferencesUrl || data.author !== 'Logitude' || !Number.isFinite(Date.parse(data.capturedAt)) ||
      !Array.isArray(data.sections) || data.sections.length !== 2 || data.sections.some((section, i) =>
        section.id !== ['official', 'mabiweb'][i] || typeof section.title !== 'string' || !Array.isArray(section.entries) || !section.entries.length || section.entries.length > 50 ||
        section.entries.some(text => typeof text !== 'string' || text.length < 8 || text.length > 6000)) || data.sha256 !== sha(JSON.stringify(data.sections))) throw new Error('Invalid rules-differences snapshot.');
  return data;
}
export function createRulesDifferencesStore({ directory, fetcher = fetch, now = Date.now, report = () => {} }) {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'tabony-rules-differences.json'), marker = join(directory, 'rules-differences-sync.json');
  let snapshot = validateRulesDifferences(JSON.parse(readFileSync(new URL('./data/question/tabony-rules-differences.json', import.meta.url), 'utf8')));
  if (existsSync(path)) { try { snapshot = validateRulesDifferences(JSON.parse(readFileSync(path, 'utf8'))); } catch { report('Regelskillnadernas cache kunde inte läsas; medföljande källkopia används.', 'error'); } }
  let lastAttempt = null, active, timer, stopped = false;
  if (existsSync(marker)) { try { const value = JSON.parse(readFileSync(marker, 'utf8')).lastAttempt; if (Number.isFinite(value)) lastAttempt = value; } catch {} }
  const update = () => {
    if (stopped || active || (lastAttempt !== null && now() - lastAttempt < dayMs)) return active;
    lastAttempt = now(); saveQuestionJson(marker, { lastAttempt });
    active = Promise.resolve().then(async () => {
      try {
        const response = await fetcher(rulesDifferencesUrl.split('#')[0], { redirect: 'error', signal: AbortSignal.timeout(15000), headers: { accept: 'text/html', 'user-agent': 'NationsBot-question-sources' } });
        if (!response.ok) throw new Error('Forum download failed.');
        let size = 0; const chunks = [];
        for await (const chunk of response.body) { size += chunk.length; if (size > 250000) throw new Error('Forum page too large.'); chunks.push(chunk); }
        const next = extractRulesDifferences(Buffer.concat(chunks).toString('utf8'), new Date(now()).toISOString());
        if (stopped) return;
        saveQuestionJson(path, next); snapshot = next;
        report('Tabonys regelskillnader är uppdaterade från ägarens foruminlägg.');
      } catch { report('Regelskillnaderna kunde inte uppdateras; senaste kompletta lokala källkopia behålls.', 'error'); }
      finally { active = null; }
    });
    return active;
  };
  const refresh = () => void Promise.resolve().then(update).catch(() => report('Regelskillnadernas uppdateringsstatus kunde inte sparas.', 'error'));
  return { snapshot: () => snapshot, update, start() { refresh(); timer = setInterval(refresh, 3600000); timer.unref?.(); }, close() { stopped = true; clearInterval(timer); } };
}
