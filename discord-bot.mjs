import { commands, autocompleteNames, handleSubscriptionCommand } from './discord-commands.mjs';

export function startDiscordBot({ token, guildId, channelId, service, report = () => {}, onState = () => {}, loadLibrary = () => import('discord.js') }) {
  let client, stopped = false, readyTimer;
  const state = value => { if (!stopped) onState(value); };
  const fail = message => { if (!stopped) { state('Fel · behöver åtgärdas'); report(message, 'error'); } };
  const close = () => { stopped = true; clearTimeout(readyTimer); client?.destroy(); onState('Avstängd'); };
  state('Ansluter');
  const ready = (async () => {
    try {
      const { Client, GatewayIntentBits, Events, MessageFlags, Routes } = await loadLibrary();
      if (stopped) return;
      client = new Client({ intents: [GatewayIntentBits.Guilds], allowedMentions: { parse: [] }, rest: { timeout: 10000 } });
      client.on(Events.Error, () => fail('Discord-boten fick ett anslutningsfel. Kontrollera bot-token och anslutningen.'));
      client.on(Events.ShardReconnecting, () => state('Återansluter'));
      client.on(Events.ShardDisconnect, () => state('Frånkopplad · återansluter'));
      client.on(Events.ShardResume, () => state('Igång'));
      client.on(Events.Invalidated, () => { fail('Discord-botens session blev ogiltig. Starta om bevakningen.'); client.destroy(); });
      client.on(Events.InteractionCreate, async interaction => {
        if (stopped || !(interaction.isChatInputCommand() || interaction.isAutocomplete())) return;
        // Only members using the designated reminders channel can self-subscribe.
        const allowed = interaction.guildId === guildId && interaction.channelId === channelId && !interaction.user.bot;
        try {
          if (interaction.isAutocomplete()) {
            const focused = interaction.options.getFocused(true);
            await interaction.respond(allowed && interaction.commandName === 'notifications' && focused.name === 'nationsname' ? autocompleteNames(service.getNames(), String(focused.value)) : []);
            return;
          }
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          if (stopped) return;
          if (!allowed) { await interaction.editReply({ content: 'Använd kommandot i den avsedda påminnelsekanalen på spelservern.', allowedMentions: { parse: [] } }); return; }
          const action = ['notifications', 'dm'].includes(interaction.commandName) ? interaction.options.getSubcommand() : null;
          let content = handleSubscriptionCommand({
            command: interaction.commandName, userId: interaction.user.id,
            action,
            displayName: interaction.member?.displayName || interaction.member?.nick || interaction.user.globalName || interaction.user.username,
            nationsName: interaction.options.getString('nationsname'),
          }, service);
          if (interaction.commandName === 'dm' && action === 'on') {
            try {
              await service.checkDm(interaction.user.id);
              content += '\nEtt kontroll-DM har skickats. Godkänn meddelandeförfrågan om Discord visar en sådan.';
            } catch {
              content += '\nKontroll-DM kunde inte bekräftas. Kontrollera att du tillåter DM från servermedlemmar och inte har blockerat boten; kör sedan /dm on igen. DM-valet är fortfarande på. Inga turpåminnelser skickas i kanalen.';
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
          if (interaction.deferred) await interaction.editReply({ content: 'Kommandot kunde inte slutföras. Kontrollera /status eller kontakta Kayser.', allowedMentions: { parse: [] } }).catch(() => {});
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
          if (!stopped) { state('Igång'); report('Discord-boten är igång. /notifications on|off, /dm on|off, /status och /help är registrerade.'); }
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
  return { close, ready };
}
