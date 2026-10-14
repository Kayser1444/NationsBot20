// Fixed windows with bounded memory; rejected calls do not prolong the window.
export function rateLimit({ limit, windowMs, maxEntries = 1000, now = Date.now }) {
  const clients = new Map();
  return {
    allow(key) {
      const time = now();
      for (const [id, entry] of clients) if (entry.expires <= time) clients.delete(id);
      let entry = clients.get(key);
      if (!entry) {
        if (clients.size >= maxEntries) clients.delete(clients.keys().next().value);
        entry = { count: 0, expires: time + windowMs };
        clients.set(key, entry);
      }
      if (entry.count >= limit) return false;
      entry.count++;
      return true;
    },
    clear() { clients.clear(); },
  };
}
