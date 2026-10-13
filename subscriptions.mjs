import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { normalizeLanguage, resolveLanguage } from './language.mjs';

export const recipients = (subscriptions, name) => {
  const value = subscriptions[name];
  return value == null ? [] : Array.isArray(value) ? value : [value];
};
export const subscriptionEntries = subscriptions => Object.keys(subscriptions).flatMap(name => recipients(subscriptions, name).map(id => [name, id]));
export function removeSubscriber(subscriptions, userId) {
  return Object.fromEntries(Object.keys(subscriptions).flatMap(name => {
    const ids = recipients(subscriptions, name).filter(id => id !== userId);
    return ids.length ? [[name, ids.length === 1 ? ids[0] : ids]] : [];
  }));
}
export function addSubscriber(subscriptions, name, userId) {
  const next = removeSubscriber(subscriptions, userId);
  const ids = [...new Set([...recipients(next, name), userId])];
  next[name] = ids.length === 1 ? ids[0] : ids;
  return validateSubscriptions(next);
}

export function validateSubscriptions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Ogiltig prenumerationslista.');
  const result = Object.create(null);
  const seen = new Set();
  for (const name of Object.keys(value)) {
    if (!name || name !== name.trim() || name.length > 150 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('Ange ett giltigt Nations-namn, exakt som på spelsajten.');
    const ids = recipients(value, name);
    if (!ids.length) throw new Error('Tom mottagarlista.');
    for (const id of ids) {
      if (typeof id !== 'string' || !/^\d{17,20}$/.test(id)) throw new Error('Discord-ID ska vara ett nummer med 17–20 siffror.');
      if (seen.has(id)) throw new Error('Det Discord-ID:t är redan kopplat till en annan prenumerant.');
      seen.add(id);
    }
    result[name] = ids.length === 1 ? ids[0] : [...ids];
  }
  return result;
}

export function readSubscriptions(path) {
  const config = JSON.parse(readFileSync(path, 'utf8'));
  const selected = validateSubscriptions(config.subscriptions ?? { [config.username]: config.discord.userId });
  const banned = validateBans(config.bannedUsers);
  return validateSubscriptions(Object.keys(banned).reduce((next, id) => removeSubscriber(next, id), selected));
}

function validateBans(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Ogiltig spärrlista.');
  const result = Object.create(null);
  for (const [id, ban] of Object.entries(value)) {
    if (!/^\d{17,20}$/.test(id) || !ban || typeof ban !== 'object' || Array.isArray(ban) ||
        typeof ban.bannedAt !== 'string' || !Number.isFinite(Date.parse(ban.bannedAt)) ||
        (ban.nationsName !== null && (typeof ban.nationsName !== 'string' || ban.nationsName.length > 150))) throw new Error('Ogiltig spärrlista.');
    result[id] = { bannedAt: ban.bannedAt, nationsName: ban.nationsName };
  }
  return result;
}

export function readBannedUsers(path) {
  return validateBans(JSON.parse(readFileSync(path, 'utf8')).bannedUsers);
}

export function isUserBanned(path, userId) {
  return Object.hasOwn(readBannedUsers(path), userId);
}

// Persist the ban and release every claim in one atomic configuration write.
export function setUserBan(path, userId, enabled) {
  if (!/^\d{17,20}$/.test(userId) || typeof enabled !== 'boolean') throw new Error('Ogiltigt Discord-ID eller spärrval.');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  const bans = validateBans(config.bannedUsers);
  let selected = validateSubscriptions(config.subscriptions ?? { [config.username]: config.discord.userId });
  if (enabled) {
    const name = subscriptionEntries(selected).find(([, id]) => id === userId)?.[0] ?? null;
    if (!Object.hasOwn(bans, userId)) bans[userId] = { bannedAt: new Date().toISOString(), nationsName: name };
    selected = removeSubscriber(selected, userId);
    // Do not silently restore a potentially stolen name after an unban.
    config.lastNationsNames = rememberedNames(config); delete config.lastNationsNames[userId];
  } else delete bans[userId];
  config.bannedUsers = bans; config.subscriptions = selected;
  const temp = path + '.tmp';
  writeFileSync(temp, JSON.stringify(config, null, 2) + '\n'); renameSync(temp, path);
  return readSubscriptions(path);
}

function rememberedNames(config) {
  const previous = config.lastNationsNames ?? {};
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)) throw new Error('Ogiltig lista med senast använda Nations-namn.');
  const result = Object.create(null);
  for (const [id, name] of Object.entries(previous)) {
    if (typeof name !== 'string') throw new Error('Ogiltigt sparat Nations-namn.');
    validateSubscriptions({ [name]: id }); result[id] = name;
  }
  return result;
}

export function readPreviousNationsName(path, userId) {
  return rememberedNames(JSON.parse(readFileSync(path, 'utf8')))[userId] ?? null;
}

export function readDmPreference(path, userId) {
  const config = JSON.parse(readFileSync(path, 'utf8'));
  const value = config.dmPreferences?.[userId];
  if (value !== undefined && typeof value !== 'boolean') throw new Error('Ogiltig sparad DM-inställning. Ingen leverans görs innan den rättats.');
  return value ?? false;
}

export function readUserLocale(path, userId) {
  const config = JSON.parse(readFileSync(path, 'utf8'));
  const locale = config.userLocales?.[userId];
  return typeof locale === 'string' && /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale) && locale.length <= 35 ? locale : null;
}

export function saveUserLocale(path, userId, locale) {
  if (!/^\d{17,20}$/.test(userId)) throw new Error('Ogiltigt Discord-ID.');
  if (typeof locale !== 'string' || locale.length > 35 || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale)) return false;
  const config = JSON.parse(readFileSync(path, 'utf8'));
  if (config.userLocales?.[userId] === locale) return false;
  config.userLocales = { ...config.userLocales, [userId]: locale };
  const temp = path + '.tmp';
  writeFileSync(temp, JSON.stringify(config, null, 2) + '\n'); renameSync(temp, path);
  return true;
}

export function readLanguageOverride(path, userId) {
  const config = JSON.parse(readFileSync(path, 'utf8'));
  const value = normalizeLanguage(config.languagePreferences?.[userId]);
  return value && value !== 'auto' ? value : null;
}

export function readBotLanguage(path, userId) {
  return resolveLanguage(readUserLocale(path, userId), readLanguageOverride(path, userId));
}

export function saveLanguagePreference(path, userId, language) {
  const selected = normalizeLanguage(language);
  if (!/^\d{17,20}$/.test(userId) || !selected) throw new Error('Invalid language preference.');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  config.languagePreferences = { ...config.languagePreferences };
  if (selected === 'auto') delete config.languagePreferences[userId];
  else config.languagePreferences[userId] = selected;
  const temp = path + '.tmp';
  writeFileSync(temp, JSON.stringify(config, null, 2) + '\n'); renameSync(temp, path);
}

export function saveDmPreference(path, userId, enabled) {
  if (!/^\d{17,20}$/.test(userId) || typeof enabled !== 'boolean') throw new Error('Ogiltig DM-inställning.');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  config.dmPreferences = { ...config.dmPreferences, [userId]: enabled };
  const temp = path + '.tmp';
  writeFileSync(temp, JSON.stringify(config, null, 2) + '\n'); renameSync(temp, path);
}

export function saveSubscriptions(path, subscriptions) {
  const selected = validateSubscriptions(subscriptions);
  const config = JSON.parse(readFileSync(path, 'utf8'));
  const bans = validateBans(config.bannedUsers);
  if (subscriptionEntries(selected).some(([, id]) => Object.hasOwn(bans, id))) throw new Error('Discord-användaren är spärrad från botten. Häv spärren först.');
  const previousNames = rememberedNames(config);
  const previous = validateSubscriptions(config.subscriptions ?? { [config.username]: config.discord.userId });
  // Preserve the removed mapping and let an explicit new mapping become the latest.
  for (const [name, id] of subscriptionEntries(previous)) previousNames[id] = name;
  for (const [name, id] of subscriptionEntries(selected)) previousNames[id] = name;
  config.subscriptions = selected;
  config.lastNationsNames = previousNames;
  const temp = path + '.tmp';
  writeFileSync(temp, JSON.stringify(config, null, 2) + '\n');
  renameSync(temp, path);
  return selected;
}
