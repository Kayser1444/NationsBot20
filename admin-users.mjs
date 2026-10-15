import { subscriptionEntries } from './subscriptions.mjs';
import { normalizeLanguage, resolveLanguage } from './language.mjs';

// Explicitly select debug fields; never expose the configuration or credentials.
export function adminUsers(config, subscriptions, matches, jobs = []) {
  const entries = subscriptionEntries(subscriptions);
  const ids = new Set([...entries.map(([, id]) => id), ...Object.keys(config.bannedUsers ?? {}),
    ...Object.keys(config.reminderPreferences ?? {}), ...Object.keys(config.lastNationsNames ?? {})]);
  return [...ids].map(userId => {
    const username = entries.find(([, id]) => id === userId)?.[0] ?? null;
    const languageOverride = normalizeLanguage(config.languagePreferences?.[userId]);
    const override = languageOverride && languageOverride !== 'auto' ? languageOverride : null;
    const reminder = config.reminderPreferences?.[userId];
    const watched = matches.filter(match => !match.finished && match.players?.some(name => name === username || (reminder?.enabled && name === reminder.name)));
    const pending = jobs.filter(job => job.userId === userId);
    return {
      userId, username, previousName: config.lastNationsNames?.[userId] ?? null,
      banned: Object.hasOwn(config.bannedUsers ?? {}, userId), bannedAt: config.bannedUsers?.[userId]?.bannedAt ?? null,
      reminders: reminder ? { enabled: reminder.enabled, name: reminder.name, time: reminder.time, timezone: reminder.timezone } : null,
      dm: config.dmPreferences?.[userId] !== false,
      language: resolveLanguage(config.userLocales?.[userId], override),
      languageOverride: override, discordLocale: config.userLocales?.[userId] ?? null,
      matches: watched.map(match => ({ id: match.id, title: match.title, player: match.state?.player ?? null,
        connected: match.status === 'connected' })),
      pending: pending.map(job => ({ matchId: job.matchId, title: job.title, player: job.player,
        attempts: job.attempts, blocked: Boolean(job.blocked), nextAt: job.nextAt })),
    };
  });
}
