// Cache only names needed by status replies; never scan the server's member list.
export function createDisplayNameCache(fetchName, { now = Date.now, ttlMs = 5 * 60 * 1000, maxEntries = 250 } = {}) {
  const cache = new Map();
  function remember(id, name, duration = ttlMs) {
    cache.delete(id);
    cache.set(id, { name, expires: now() + duration });
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
  }
  return {
    remember,
    async resolve(id) {
      const cached = cache.get(id);
      if (cached?.expires > now()) return cached.pending ?? cached.name;
      const pending = Promise.resolve().then(() => fetchName(id)).then(name => {
        const selected = typeof name === 'string' && name.trim() ? name : null;
        // A command may have supplied a newer display name while this lookup ran.
        if (cache.get(id)?.pending === pending) remember(id, selected, selected ? ttlMs : 30000);
        return cache.get(id)?.name ?? selected;
      }).catch(() => {
        if (cache.get(id)?.pending === pending) remember(id, null, 30000);
        return cache.get(id)?.name ?? null;
      });
      cache.set(id, { pending, expires: now() + ttlMs });
      while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
      return pending;
    },
  };
}

export async function statusServiceWithNames(service, userId, resolveName) {
  const subscriptions = service.getSubscriptions();
  const own = Object.entries(subscriptions).find(([, id]) => id === userId)?.[0];
  const initial = service.getStatus(own, userId);
  const ids = own ? [...new Set((initial.matchList ?? []).filter(match => Object.hasOwn(subscriptions, match.player)).map(match => subscriptions[match.player]))] : [];
  const names = new Map(await Promise.all(ids.map(async id => {
    try { return [id, await resolveName(id)]; } catch { return [id, null]; }
  })));
  return { ...service, getStatus: (username, id) => {
    // Turns and subscriptions may have changed while Discord names were fetched.
    const current = service.getSubscriptions(), state = service.getStatus(username, id);
    return { ...state, matchList: state.matchList?.map(match => ({ ...match,
      discordName: Object.hasOwn(current, match.player) ? names.get(current[match.player]) ?? null : null,
    })) };
  } };
}
