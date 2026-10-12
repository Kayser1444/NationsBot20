import { validateSubscriptions } from './subscriptions.mjs';
import { resolveLanguage, normalizeLanguage, text } from './language.mjs';

export const commands = [
  { name: 'notifications', description: 'Turn Nations reminders on or off', type: 1, options: [
    { name: 'on', description: 'Enable turn reminders', type: 1, options: [
      { name: 'nationsname', description: 'Exact Nations name; omit to match your Discord display name', type: 3, required: false, autocomplete: true, max_length: 100 },
    ] },
    { name: 'off', description: 'Disable your turn reminders', type: 1 },
  ] },
  { name: 'status', description: 'Show your Nations subscription and monitored games', type: 1 },
  { name: 'dm', description: 'Choose private or channel reminders', type: 1, options: [
    { name: 'on', description: 'Send your reminders only by DM', type: 1 },
    { name: 'off', description: 'Send your reminders in the reminders channel (default)', type: 1 },
  ] },
  { name: 'help', description: 'Show commands and what NationsBot can do', type: 1 },
  { name: 'language', description: 'Choose your bot language or follow Discord automatically', type: 1, options: [
    { name: 'locale', description: 'Swedish (sv-SE), English (en-US), or automatic (auto)', type: 3, required: true, autocomplete: true, max_length: 35 },
  ] },
];
export const helpMessage = text('sv-SE', 'help');
const quote = name => '`' + name.replace(/[`\r\n]/g, '') + '`';
const folded = name => name.toLocaleLowerCase('sv-SE');
// A server nickname may append a real name: "Kayser (Jonas Adolphson)".
// Only automatic Discord-name matching removes that trailing annotation.
const playerAlias = name => name.trim().replace(/\s+\([^()]*\)\s*$/u, '').trim();

export function autocompleteNames(names, query) {
  const selected = folded(query.trim());
  return [...new Set(names)].filter(name => name.length <= 100 && folded(name).includes(selected))
    .sort((a, b) => Number(!folded(a).startsWith(selected)) - Number(!folded(b).startsWith(selected)) || a.localeCompare(b, 'sv'))
    .slice(0, 25).map(name => ({ name, value: name }));
}

// Called synchronously after Discord acknowledges the interaction. Check and save
// have no await between them, so simultaneous claims cannot replace each other.
export function handleSubscriptionCommand({ command, action, userId, displayName, nationsName, locale }, { getSubscriptions, getNames, commit, getStatus, getPreviousName = () => null, getDm = () => false, getLocale = () => null, getLanguageOverride = () => null, setLanguage, setDm }) {
  const language = resolveLanguage(getLocale(userId), getLanguageOverride(userId));
  const t = (key, values) => text(language, key, values);
  if (command === 'help') return t('help');
  if (command === 'language') {
    const selected = normalizeLanguage(locale);
    if (!selected) return t('languageUsage');
    setLanguage(userId, selected);
    const next = resolveLanguage(getLocale(userId), selected);
    return text(next, selected === 'auto' ? 'languageAuto' : 'languageSet', { language: text(next, 'languageName'), locale: quote(next) });
  }
  if (command === 'dm') {
    if (!['on', 'off'].includes(action)) return t('dmUsage');
    setDm(userId, action === 'on');
    return t(action === 'on' ? 'dmOn' : 'dmOff');
  }
  const current = getSubscriptions();
  const own = Object.entries(current).find(([, id]) => id === userId)?.[0];
  if (command === 'status') {
    const state = getStatus(own, userId);
    const mode = t(getDm(userId) ? 'modeDm' : 'modeChannel');
    const blocked = state.blocked ? t('blocked') : '';
    const detectedLocale = getLocale(userId);
    let detected = t('undetected');
    if (detectedLocale) {
      let label = detectedLocale;
      try { label = new Intl.DisplayNames([language], { type: 'language' }).of(detectedLocale); } catch {}
      detected = t('detected', { name: label, locale: quote(detectedLocale) });
    }
    const selectedLanguage = t('botLanguage', { name: t('languageName'), locale: quote(language), source: t(getLanguageOverride(userId) ? 'override' : 'automatic') });
    const summary = (own ? t('subscribedStatus', { name: quote(own), count: state.matches, delivery: t(state.discordEnabled ? 'enabled' : 'disabled') }) : t('noSubscription')) + ' ' + mode + blocked + '\n' + detected + '\n' + selectedLanguage;
    if (!own || !state.matchList?.length) return summary;
    const rows = state.matchList.map(match => {
      const title = (match.title || `${t('game')} ${match.id}`).replace(/[\r\n\t]+/g, ' ').replace(/[\\`*_[\]<>@]/g, '').slice(0, 100);
      return `• [${title}](<https://games.tabony.net/nations/${encodeURIComponent(match.id)}/>) · ID ${match.id} · ${t(match.connected ? 'connected' : 'disconnected')}`;
    });
    return summary + '\n\n' + t('gamesHeading') + '\n' + rows.join('\n');
  }
  if (command === 'notifications' && action === 'off') {
    if (!own) return t('nothingToStop');
    const next = { ...current }; delete next[own]; commit(next);
    return t('stopped', { name: quote(own) });
  }
  if (command !== 'notifications' || action !== 'on') return t('unknown');
  const names = [...new Set([...getNames(), ...Object.keys(current)])];
  const previousName = nationsName == null ? own || getPreviousName(userId) : null;
  let name;
  if (nationsName !== null && nationsName !== undefined) {
    name = nationsName.trim();
    const similar = names.filter(item => folded(item) === folded(name));
    if (!names.includes(name) && similar.length) return t('exactCase', { names: similar.map(quote).join(', ') });
  } else if (previousName) {
    // Reuse the exact historical spelling even if no current game lists it.
    name = previousName;
  } else {
    const matches = names.filter(item => folded(item) === folded(playerAlias(displayName)));
    if (!matches.length) return t('noName');
    if (matches.length > 1) return t('ambiguous', { names: matches.map(quote).join(', ') });
    name = matches[0];
  }
  if (Object.hasOwn(current, name) && current[name] !== userId) return t('occupied', { name: quote(name) });
  if (own === name) return t('already', { name: quote(name) });
  if (own) return t('switchName', { name: quote(own) });
  try { validateSubscriptions({ [name]: userId }); } catch { return t('invalidName'); }
  commit(validateSubscriptions({ ...current, [name]: userId }));
  return t('subscribed', { name: quote(name), destination: t(getDm(userId) ? 'destinationDm' : 'destinationChannel') });
}
