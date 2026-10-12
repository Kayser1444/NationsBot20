import { readFileSync, writeFileSync, renameSync } from 'node:fs';

export function validateSubscriptions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Ogiltig prenumerationslista.');
  const result = Object.create(null);
  for (const [name, id] of Object.entries(value)) {
    if (!name || name !== name.trim() || name.length > 150 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('Ange ett giltigt Nations-namn, exakt som på spelsajten.');
    if (typeof id !== 'string' || !/^\d{17,20}$/.test(id)) throw new Error('Discord-ID ska vara ett nummer med 17–20 siffror.');
    if (Object.values(result).includes(id)) throw new Error('Det Discord-ID:t är redan kopplat till en annan prenumerant.');
    result[name] = id;
  }
  return result;
}

export function readSubscriptions(path) {
  const config = JSON.parse(readFileSync(path, 'utf8'));
  return validateSubscriptions(config.subscriptions ?? { [config.username]: config.discord.userId });
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
  const previousNames = rememberedNames(config);
  const previous = validateSubscriptions(config.subscriptions ?? { [config.username]: config.discord.userId });
  // Preserve the removed mapping and let an explicit new mapping become the latest.
  for (const [name, id] of Object.entries(previous)) previousNames[id] = name;
  for (const [name, id] of Object.entries(selected)) previousNames[id] = name;
  config.subscriptions = selected;
  config.lastNationsNames = previousNames;
  const temp = path + '.tmp';
  writeFileSync(temp, JSON.stringify(config, null, 2) + '\n');
  renameSync(temp, path);
  return selected;
}
