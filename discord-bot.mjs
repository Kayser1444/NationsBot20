import { commands, autocompleteNames, handleSubscriptionCommand } from './discord-commands.mjs';
import { autocompleteLanguages, resolveLanguage, text } from './language.mjs';
import { createDisplayNameCache, statusServiceWithNames } from './status-turns.mjs';

export function startDiscordBot({ token, guildId, channelId, service, report = () => {}, onState = () => {}, loadLibrary = () => import('discord.js') }) {
  let client, displayNames, stopped = false, readyTimer;
  const state = value => { if (!stopped) onState(value); };
  const fail = message => { if (!stopped) { state('Fel · behöver åtgärdas'); report(message, 'error'); } };
  const close = () => { stopped = true; clearTimeout(readyTimer); client?.destroy(); onState('Avstängd'); };
  state('Ansluter');
  const ready = (async () => {
    try {
      const { Client, GatewayIntentBits, Events, MessageFlags, Routes } = await loadLibrary();
      if (stopped) return;
      client = new Client({ intents: [GatewayIntentBits.Guilds], allowedMentions: { parse: [] }, rest: { timeout: 10000 } });
      displayNames = createDisplayNameCache(async userId => {
        const member = await client.rest.get(Routes.guildMember(guildId, userId), { signal: AbortSignal.timeout(4000) });
        if (member?.user?.id !== userId) return null;
        return member.nick || member.user.global_name || member.user.username;
      });
      client.on(Events.Error, () => fail('Discord-boten fick ett anslutningsfel. Kontrollera bot-token och anslutningen.'));
      client.on(Events.ShardReconnecting, () => state('Återansluter'));
      client.on(Events.ShardDisconnect, () => state('Frånkopplad · återansluter'));
      client.on(Events.ShardResume, () => state('Igång'));
      client.on(Events.Invalidated, () => { fail('Discord-botens session blev ogiltig. Starta om bevakningen.'); client.destroy(); });
      client.on(Events.InteractionCreate, async interaction => {
        if (stopped || !(interaction.isChatInputCommand() || interaction.isAutocomplete())) return;
        // Only members using the designated reminders channel can self-subscribe.
        const smTable = interaction.commandName === 'smtable';
        const smDm = smTable && interaction.isChatInputCommand() && interaction.options.getString('dm') === 'on';
        const allowed = interaction.guildId === guildId && (smTable || interaction.channelId === channelId) && !interaction.user.bot;
        const language = () => resolveLanguage(interaction.locale ?? service.getLocale?.(interaction.user.id), service.getLanguageOverride?.(interaction.user.id));
        try {
          if (interaction.isAutocomplete()) {
            const focused = interaction.options.getFocused(true);
            const choices = !allowed || service.isBanned?.(interaction.user.id) ? []
              : interaction.commandName === 'language' && focused.name === 'locale' ? autocompleteLanguages(focused.value)
              : interaction.commandName === 'notifications' && focused.name === 'nationsname' ? autocompleteNames(service.getNames(), String(focused.value)) : [];
            await interaction.respond(choices);
            return;
          }
          await interaction.deferReply(smTable && allowed && !smDm && !service.isBanned?.(interaction.user.id) ? {} : { flags: MessageFlags.Ephemeral });
          if (stopped) return;
          if (!allowed) { await interaction.editReply({ content: text(language(), 'wrongChannel'), allowedMentions: { parse: [] } }); return; }
          if (service.isBanned?.(interaction.user.id)) { await interaction.editReply({ content: text(language(), 'userBanned'), allowedMentions: { parse: [] } }); return; }
          if (smTable) {
            const table = service.getSmTable(interaction.options.getString('div'), interaction.user.id);
            if (smDm) {
              try {
                await service.sendSmTableDm(interaction.user.id, table);
                await interaction.editReply({ content: 'SM-tabellen har skickats som DM.', allowedMentions: { parse: [] } });
              } catch {
                await interaction.editReply({ content: 'DM kunde inte bekräftas. Kontrollera att du tillåter DM från boten. Tabellen skickas inte publikt.', allowedMentions: { parse: [] } });
              }
            } else await interaction.editReply({ content: table, allowedMentions: { parse: [] } });
            return;
          }
          service.captureLocale?.(interaction.user.id, interaction.locale);
          displayNames.remember(interaction.user.id, interaction.member?.displayName || interaction.member?.nick || interaction.user.globalName || interaction.user.username);
          const commandService = interaction.commandName === 'status'
            ? await statusServiceWithNames(service, interaction.user.id, id => displayNames.resolve(id)) : service;
          if (stopped) return;
          const action = ['notifications', 'dm'].includes(interaction.commandName) ? interaction.options.getSubcommand() : null;
          let content = handleSubscriptionCommand({
            command: interaction.commandName, userId: interaction.user.id,
            action,
            displayName: interaction.member?.displayName || interaction.member?.nick || interaction.user.globalName || interaction.user.username,
            nationsName: interaction.options.getString('nationsname'),
            locale: interaction.commandName === 'language' ? interaction.options.getString('locale') : undefined,
          }, commandService);
          if (interaction.commandName === 'dm' && action === 'on' && !service.isBanned?.(interaction.user.id)) {
            try {
              await service.checkDm(interaction.user.id);
              content += '\n' + text(language(), 'dmConfirmed');
            } catch {
              content += '\n' + text(language(), 'dmFailed');
            }
          }
          // Keep every game visible even when the list exceeds Discord's message limit.
          const pages = [''];
          for (const line of content.split('\n')) {
            if ((pages.at(-1) + '\n' + line).length > 1900) pages.push('');
            pages[pages.length - 1] += (pages.at(-1) ? '\n' : '') + line;
          }
          await interaction.editReply({ content: pages[0], allowedMentions: { parse: [] } });
          for (const page of pages.slice(1)) {
            await interaction.followUp({ content: page, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
          }
        } catch {
          report('Ett Discord-kommando kunde inte slutföras. Kontrollera prenumerationen i statusfönstret.', 'error');
          if (interaction.deferred) await interaction.editReply({ content: text(language(), 'commandFailed'), allowedMentions: { parse: [] } }).catch(() => {});
        }
      });
      client.once(Events.ClientReady, async () => {
        clearTimeout(readyTimer);
        if (stopped) return;
        try {
          // Upsert only our own commands; do not bulk-delete other app commands.
          for (const command of commands) {
            if (stopped) return;
            await client.rest.post(Routes.applicationGuildCommands(client.application.id, guildId), { body: command });
          }
          const existing = await client.rest.get(Routes.applicationGuildCommands(client.application.id, guildId));
          for (const old of existing) {
            if (stopped) return;
            if (old.type === 1 && ['prenumerera', 'avprenumerera', 'hjälp'].includes(old.name)) {
              await client.rest.delete(Routes.applicationGuildCommand(client.application.id, guildId, old.id));
            }
          }
          if (!stopped) { state('Igång'); report('Discord-boten är igång. /notifications on|off, /dm on|off, /status, /help, /language och /smtable är registrerade.'); }
        } catch { fail('Discord-kommandona kunde inte registreras. Kontrollera att boten är tillagd på rätt server.'); }
      });
      readyTimer = setTimeout(() => { fail('Discord-boten kunde inte ansluta inom 30 sekunder. Kontrollera token och starta om.'); client.destroy(); }, 30000);
      await client.login(token);
      if (stopped) client.destroy();
    } catch {
      clearTimeout(readyTimer); client?.destroy();
      fail('Discord-boten kunde inte starta. Kontrollera bot-token och att dess programbibliotek är installerat.');
    }
  })();
  return { close, ready, resolveDisplayName: async userId => stopped ? null : displayNames?.resolve(userId) ?? null };
}
