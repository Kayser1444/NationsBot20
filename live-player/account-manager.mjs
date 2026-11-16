import { accountNamePattern, matchIdPattern } from './accounts.mjs';
import { isAuthorized } from './discovery.mjs';
import { modelChoices } from './settings.mjs';
import { isExperimentalModel } from './rl-policy.mjs';

const conflict = message => Object.assign(new Error(message), { status: 409 });

export function createAccountManager({ accounts, base, createRuntime, experiments }) {
  const entries = new Map(), retiring = new Set();
  const legacyId = accounts.legacyId();
  const background = promise => void promise.catch(() => {});

  function attach(account) {
    const entry = { account };
    entry.runtime = createRuntime({
      username: account.username, password: account.password, play: true, accountId: account.id,
      storageId: account.id === legacyId ? undefined : account.id, includeArchive: Boolean(account.matchIds),
      accountEnabled: () => entry.account.enabled,
      defaultModel: count => count === 2 || !isExperimentalModel(entry.account.defaultModel) ? entry.account.defaultModel : null,
      hideUnauthorized: () => Boolean(entry.account.matchIds),
      onLobbyStarted(match) {
        for (const { account, runtime } of entries.values()) {
          if (match.players.includes(account.username)) background(runtime.controller.lobbyStarted());
        }
      },
      authorize(game, settings) {
        if (entry.account.matchIds) {
          return entry.account.matchIds.includes(game.id) && !game.invitation &&
            ['Your turn:', 'Not your turn:'].includes(game.section) &&
            game.players.length === game.playerCount &&
            isAuthorized(game, { ...settings, authorizedPlayers: game.players }, account.username);
        }
        const managedNames = [...entries.values()].filter(other => !other.account.matchIds).map(other => other.account.username);
        return isAuthorized(game, { ...settings, authorizedPlayers: [...settings.authorizedPlayers, ...managedNames] }, account.username);
      },
    });
    entries.set(account.id, entry);
    return entry;
  }
  for (const account of accounts.list()) attach(account);
  const controllers = () => [...entries.values()].map(entry => entry.runtime.controller);
  const reconcile = () => controllers().forEach(controller => controller.reconcile());

  function validateDefault(model) {
    if (model === null || modelChoices.some(choice => choice.id === model) ||
        (isExperimentalModel(model) && experiments.get(model))) return;
    throw new Error('Choose an available default model.');
  }

  return {
    status() {
      const statuses = [...entries.values()].map(({ account, runtime }) => ({ account, status: runtime.controller.status() }));
      const dates = key => statuses.map(({ status }) => status[key]).filter(stamp => stamp !== null);
      const last = dates('lastPollAt'), next = dates('nextPollAt');
      return {
        ...base.status(), accountsAvailable: true, playAvailable: statuses.some(({ account }) => account.enabled),
        polling: statuses.some(({ status }) => status.polling),
        lastPollAt: last.length ? Math.max(...last) : null,
        nextPollAt: next.length ? Math.min(...next) : null,
        accounts: statuses.map(({ account: { id, username, enabled, defaultModel, matchIds }, status }) =>
          ({ id, username, enabled, defaultModel, matchIds, socket: status.accountSocket, error: status.lastPollError })),
        games: statuses.flatMap(({ status }) => status.games).sort((a, b) => Number(b.id) - Number(a.id)),
        events: statuses.flatMap(({ account, status }) => status.events.map(event => ({
          ...event, message: `${account.username} · ${event.message}`,
        }))).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 50),
      };
    },
    save(input, revision, actor) {
      base.save(input, revision, actor);
      reconcile();
      return this.status();
    },
    changeAccount(input) {
      if (input.action === 'add') {
        const { username, password, defaultModel = null, matchIds = null } = input;
        if (typeof username !== 'string' || !accountNamePattern.test(username)) throw new Error('Enter the exact Tabony username.');
        if (typeof password !== 'string' || !password || password.length > 1024) throw new Error('Enter the Tabony password.');
        if (matchIds !== null && (!Array.isArray(matchIds) || !matchIds.length || matchIds.length > 200 ||
            matchIds.some(id => typeof id !== 'string' || !matchIdPattern.test(id)))) {
          throw new Error('Enter one or more Tabony match IDs for this takeover account.');
        }
        validateDefault(defaultModel);
        const id = accounts.idFor(username);
        if (entries.has(id) || retiring.has(id)) throw conflict('This account is already registered or is still disconnecting.');
        attach(accounts.add({ username, password, defaultModel, matchIds: matchIds && [...new Set(matchIds)], enabled: false }));
      } else {
        const entry = entries.get(input.accountId);
        if (!entry) throw conflict('This account is no longer registered.');
        if (input.action === 'delete') {
          accounts.delete(entry.account.id);
          entries.delete(entry.account.id);
          retiring.add(entry.account.id);
          void entry.runtime.close().then(() => retiring.delete(entry.account.id));
          reconcile();
        } else if (['start', 'stop', 'default-model'].includes(input.action)) {
          const next = { ...entry.account };
          if (input.action === 'default-model') {
            validateDefault(input.defaultModel);
            next.defaultModel = input.defaultModel;
          } else next.enabled = input.action === 'start';
          accounts.save(next);
          entry.account = next;
          entry.runtime.controller.reconcile();
          if (input.action === 'start') background(entry.runtime.controller.resume());
        } else throw new Error('Unknown account action.');
      }
      return this.status();
    },
    changeMatchModel(input, actor) {
      const entry = entries.get(input.accountId);
      if (!entry) throw conflict('Choose the account playing this seat.');
      entry.runtime.controller.changeMatchModel(input, actor);
      return this.status();
    },
    async poll(reason) { await Promise.allSettled(controllers().map(controller => controller.poll(reason))); },
    async tick() { await Promise.allSettled(controllers().map(controller => controller.tick())); },
    close() {
      const drained = Promise.allSettled([...entries.values()].map(entry => entry.runtime.close()));
      accounts.close();
      return drained;
    },
  };
}
