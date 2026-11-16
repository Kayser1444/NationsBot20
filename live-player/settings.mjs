import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import defaults from './default-weights.json' with { type: 'json' };
import checkpoints from './models.json' with { type: 'json' };
import deployed from './trained-weights.json' with { type: 'json' };
import { validateModel, weightsFor } from './scorer.mjs';

const catalog = { ...checkpoints,
  'human-baseline-v1': { label: 'Human baseline (previous settings ID)', model: deployed },
  'human-baseline-v2': { label: 'Human baseline v2 — dynasties', model: deployed } };

export const initialSettings = {
  pollingEnabled: true, pollIntervalSeconds: 60, playEnabled: true, autoAccept: true,
  authorizedPlayers: ['Kayser'], playerCounts: [2, 3, 4, 5], maxConcurrentGames: 1,
  moveDelayMs: 500, growthResources: 2,
  twoPlayerModel: 'human-baseline-v2', multiplayerModel: 'human-baseline-v2',
  weightOverrides: { '2': {}, '4': {} },
};

export function validateSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Settings must be an object.');
  for (const key of Object.keys(input)) if (!Object.hasOwn(initialSettings, key)) throw new Error(`Unknown setting: ${key}`);
  const s = { ...structuredClone(initialSettings), ...input };
  for (const key of ['pollingEnabled', 'playEnabled', 'autoAccept']) if (typeof s[key] !== 'boolean') throw new Error(`Invalid ${key}.`);
  for (const [key, min, max] of [['pollIntervalSeconds', 15, 86400], ['maxConcurrentGames', 1, 10], ['moveDelayMs', 0, 30000], ['growthResources', 1, 4]]) {
    if (!Number.isInteger(s[key]) || s[key] < min || s[key] > max) throw new Error(`${key} must be between ${min} and ${max}.`);
  }
  if (!Array.isArray(s.authorizedPlayers) || s.authorizedPlayers.length > 100 ||
      s.authorizedPlayers.some(name => typeof name !== 'string' || !/^[a-zA-Z0-9_]{1,20}$/.test(name))) throw new Error('Use exact Tabony account names, one per line.');
  s.authorizedPlayers = [...new Set(s.authorizedPlayers)];
  if (!Array.isArray(s.playerCounts) || !s.playerCounts.length || s.playerCounts.some(n => ![2, 3, 4, 5].includes(n))) throw new Error('Choose player counts from two to five.');
  s.playerCounts = [...new Set(s.playerCounts)].sort();
  for (const key of ['twoPlayerModel', 'multiplayerModel']) if (!Object.hasOwn(catalog, s[key])) throw new Error('Choose an available model checkpoint.');
  if (!s.weightOverrides || typeof s.weightOverrides !== 'object' || Array.isArray(s.weightOverrides) ||
      Object.keys(s.weightOverrides).some(key => !['2', '4'].includes(key))) throw new Error('Weight overrides must use profiles 2 and 4.');
  for (const [count, weights] of Object.entries(s.weightOverrides)) {
    if (!weights || typeof weights !== 'object' || Array.isArray(weights)) throw new Error('Invalid weight overrides.');
    validateModel({ schemaVersion: 1, weights: defaults.weights, profiles: { [count]: weights } });
  }
  s.weightOverrides = { '2': {}, '4': {}, ...s.weightOverrides };
  return structuredClone(s);
}

export function modelForSettings(settings) {
  const model = structuredClone(defaults);
  model.name = `${settings.twoPlayerModel} (2p), ${settings.multiplayerModel} (3–5p)`;
  model.profiles = {
    '2': { ...weightsFor(catalog[settings.twoPlayerModel].model, 2), ...settings.weightOverrides['2'] },
    '4': { ...weightsFor(catalog[settings.multiplayerModel].model, 4), ...settings.weightOverrides['4'] },
  };
  model.playerPolicies = { '2': settings.twoPlayerModel, '4': settings.multiplayerModel };
  return validateModel(model);
}

export function settingsStore(directory) {
  const path = join(directory, 'player-settings.json');
  let saved = { revision: 0, settings: structuredClone(initialSettings), updatedAt: null, updatedBy: null };
  if (existsSync(path)) {
    saved = JSON.parse(readFileSync(path, 'utf8'));
    saved.settings = validateSettings(saved.settings);
    if (!Number.isSafeInteger(saved.revision) || saved.revision < 0) throw new Error('Invalid saved settings revision.');
    if ((saved.baselineVersion ?? 0) < 2) {
      // Promote existing installations once; preserve account and polling settings.
      const settings = { ...saved.settings };
      for (const key of ['twoPlayerModel', 'multiplayerModel']) {
        if (!saved.baselineVersion || settings[key] === 'human-baseline-v1') settings[key] = 'human-baseline-v2';
      }
      saved = { ...saved, baselineVersion: 2, revision: saved.revision + 1, settings,
        updatedAt: new Date().toISOString(), updatedBy: 'human-baseline-v2 migration' };
      writeFileSync(path + '.tmp', JSON.stringify(saved, null, 2) + '\n', { mode: 0o600 });
      renameSync(path + '.tmp', path);
    }
  }
  return {
    read: () => structuredClone(saved),
    save(input, revision, actor) {
      if (revision !== saved.revision) throw Object.assign(new Error('Settings changed. Refresh before saving.'), { status: 409 });
      const next = { baselineVersion: 2, settings: validateSettings(input), revision: saved.revision + 1,
        updatedAt: new Date().toISOString(), updatedBy: actor ?? null };
      writeFileSync(path + '.tmp', JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
      renameSync(path + '.tmp', path);
      saved = next;
      return this.read();
    },
  };
}

export const modelChoices = Object.entries(catalog).filter(([id]) => id !== 'human-baseline-v1').map(([id, entry]) => ({ id, label: entry.label }));
