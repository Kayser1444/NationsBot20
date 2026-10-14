import { commands, autocompleteNames, handleSubscriptionCommand } from './discord-commands.mjs';
import { autocompleteLanguages, resolveLanguage, text } from './language.mjs';
import { createDisplayNameCache, statusServiceWithNames } from './status-turns.mjs';
import { rateLimit } from './rate-limit.mjs';
import { cardBank } from './card-bank.mjs';
import { prepareCardImage } from './card-image-delivery.mjs';

const interactionPayload = message => {
  const { allowed_mentions, ...body } = message;
  return { ...body, allowedMentions: allowed_mentions };
};

export function startDiscordBot({ token, guildId, channelId, service, report = () => {}, onState = () => {}, loadLibrary = () => import('discord.js'), now = Date.now, prepareImage = prepareCardImage }) {
  const edits = rateLimit({ limit: 5, windowMs: 10000, now });
  const dmControls = rateLimit({ limit: 1, windowMs: 60000, now });
  let client, displayNames, stopped = false, readyTimer;
  const state = value => { if (!stopped) onState(value); };
  const fail = message => { if (!stopped) { state('Fel · behöver åtgärdas'); report(message, 'error'); } };
  const close = () => { stopped = true; clearTimeout(readyTimer); edits.clear(); dmControls.clear(); client?.destroy(); onState('Avstängd'); };
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
        const faqButton = interaction.isButton?.() && interaction.customId?.startsWith('cardfaq:');
        if (!stopped && faqButton) {
          const language = resolveLanguage(interaction.locale ?? service.getLocale?.(interaction.user.id), service.getLanguageOverride?.(interaction.user.id));
          const privateReply = key => interaction.followUp({ content: text(language, key), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
          try {
            // Each click has its own interaction, so old cards survive a bot restart.
            // Acknowledge before DM membership checks and never replace the card on denial.
            await interaction.deferUpdate();
            if (interaction.user.bot || interaction.message?.author?.id !== client.application.id) { await privateReply('cardFaqExpired'); return; }
            if (service.isBanned?.(interaction.user.id)) { await privateReply('userBanned'); return; }
            let allowed = interaction.guildId ? client.guilds.cache.has(interaction.guildId) : false;
            if (!interaction.guildId) {
              const signal = AbortSignal.timeout(4000);
              for (const id of client.guilds.cache.keys()) {
                if (signal.aborted || stopped) break;
                try {
                  const member = await client.rest.get(Routes.guildMember(id, interaction.user.id), { signal });
                  if (member?.user?.id === interaction.user.id) { allowed = true; break; }
                } catch { /* Membership failures grant no access to the FAQ. */ }
              }
            }
            if (stopped) return;
            if (!allowed) { await privateReply(interaction.guildId ? 'wrongChannel' : 'dmMembershipRequired'); return; }
            if (service.isBanned?.(interaction.user.id)) { await privateReply('userBanned'); return; }
            const reply = cardBank.renderButton(interaction.customId);
            if (!reply?.ok) { await privateReply('cardFaqExpired'); return; }
            const message = await prepareImage(reply, {attachments:[...(interaction.message?.attachments?.values?.() ?? [])],
              imageUrl:interaction.message?.embeds?.[0]?.image?.url,allowUpload:interaction.appPermissions?.has('AttachFiles') !== false});
            if (stopped) return;
            await interaction.editReply(interactionPayload(message));
          } catch {
            report('Kortets FAQ-vy kunde inte uppdateras.', 'error');
            if (interaction.deferred) await privateReply('commandFailed').catch(() => {});
          }
          return;
        }
        if (stopped || !(interaction.isChatInputCommand() || interaction.isAutocomplete())) return;
        // All installed servers share user subscriptions; only SM has channel delivery.
        const inDm = !interaction.guildId && interaction.context === 1;
        const smTable = interaction.commandName === 'smtable';
        const cardCommand = interaction.commandName === 'card';
        let allowed = !interaction.user.bot && (inDm || !!interaction.guildId);
        let dmMember = null;
        const language = () => resolveLanguage(interaction.locale ?? service.getLocale?.(interaction.user.id), service.getLanguageOverride?.(interaction.user.id));
        try {
          if (inDm && allowed && !service.isBanned?.(interaction.user.id)) {
            // Acknowledge before the membership lookup; ordinary chat messages
            // need no intent and are never consumed by this slash-command bot.
            if (interaction.isChatInputCommand()) await interaction.deferReply({});
            allowed = false;
            const membershipSignal = AbortSignal.timeout(4000);
            for (const id of client.guilds.cache.keys()) {
              if (membershipSignal.aborted || stopped) break;
              try {
                const member = await client.rest.get(Routes.guildMember(id, interaction.user.id), { signal: membershipSignal });
                if (member?.user?.id === interaction.user.id) { dmMember = member; allowed = true; break; }
              } catch { /* Try another installed server; lookup failures grant no access. */ }
            }
          }
          if (interaction.isAutocomplete()) {
            const focused = interaction.options.getFocused(true);
            const choices = !allowed || service.isBanned?.(interaction.user.id) ? []
              : interaction.commandName === 'language' && focused.name === 'locale' ? autocompleteLanguages(focused.value)
              : cardCommand && focused.name === 'name' ? cardBank.autocomplete(focused.value, language())
              : interaction.commandName === 'notifications' && focused.name === 'nationsname' ? autocompleteNames(service.getNames(), String(focused.value)) : [];
            await interaction.respond(choices);
            return;
          }
          const cardReply = cardCommand && allowed && !service.isBanned?.(interaction.user.id)
            ? cardBank.render(interaction.options.getString('name'), language()) : null;
          if (!interaction.deferred) await interaction.deferReply(inDm || ((smTable || cardReply?.ok) && allowed && !service.isBanned?.(interaction.user.id)) ? {} : { flags: MessageFlags.Ephemeral });
          if (stopped) return;
          if (!allowed) { await interaction.editReply({ content: text(language(), inDm ? 'dmMembershipRequired' : 'wrongChannel'), allowedMentions: { parse: [] } }); return; }
          if (service.isBanned?.(interaction.user.id)) { await interaction.editReply({ content: text(language(), 'userBanned'), allowedMentions: { parse: [] } }); return; }
          if (cardCommand) {
            service.captureLocale?.(interaction.user.id, interaction.locale);
            const message = await prepareImage(cardReply, {allowUpload:interaction.appPermissions?.has('AttachFiles') !== false});
            if (stopped) return;
            await interaction.editReply(interactionPayload(message));
            for (const message of cardReply.messages.slice(1)) {
              if (stopped) return;
              await interaction.followUp(interactionPayload(message));
            }
            return;
          }
          if (['notifications', 'dm', 'language'].includes(interaction.commandName) && !edits.allow(interaction.user.id)) {
            await interaction.editReply({ content: text(language(), 'commandCooldown'), allowedMentions: { parse: [] } }); return;
          }
          if (smTable) {
            service.captureLocale?.(interaction.user.id, interaction.locale);
            const table = service.getSmTable(interaction.options.getString('div'), interaction.user.id, language());
            await interaction.editReply({ content: table, allowedMentions: { parse: [] } });
            return;
          }
          service.captureLocale?.(interaction.user.id, interaction.locale);
          displayNames.remember(interaction.user.id, interaction.member?.displayName || interaction.member?.nick || dmMember?.nick || interaction.user.globalName || interaction.user.username);
          const commandService = interaction.commandName === 'status'
            ? await statusServiceWithNames(service, interaction.user.id, id => displayNames.resolve(id)) : service;
          if (stopped) return;
          const action = ['notifications', 'dm'].includes(interaction.commandName) ? interaction.options.getSubcommand() : null;
          const channelDeliveryAllowed = interaction.guildId === guildId && interaction.channelId === channelId;
          const requestedDm = interaction.commandName === 'notifications' && action === 'on' ? interaction.options.getString('dm') : undefined;
          if (!channelDeliveryAllowed && (requestedDm === 'off' || (interaction.commandName === 'dm' && action === 'off'))) {
            await interaction.editReply({ content: text(language(), 'channelDeliveryRestricted'), allowedMentions: { parse: [] } }); return;
          }
          let notificationsEnabled = false;
          let content = handleSubscriptionCommand({
            command: interaction.commandName, userId: interaction.user.id,
            action,
            displayName: interaction.member?.displayName || interaction.member?.nick || dmMember?.nick || interaction.user.globalName || interaction.user.username,
            nationsName: interaction.options.getString('nationsname'),
            dm: interaction.commandName === 'notifications' && action === 'on'
              ? requestedDm ?? (channelDeliveryAllowed ? undefined : 'on') : undefined,
            locale: interaction.commandName === 'language' ? interaction.options.getString('locale') : undefined,
          }, { ...commandService, onNotificationsEnabled: () => { notificationsEnabled = true; } });
          if (((notificationsEnabled && service.getDm?.(interaction.user.id)) || (interaction.commandName === 'dm' && action === 'on')) && !service.isBanned?.(interaction.user.id) && dmControls.allow(interaction.user.id)) {
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
            await interaction.followUp({ content: page, ...(inDm ? {} : { flags: MessageFlags.Ephemeral }), allowedMentions: { parse: [] } });
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
            await client.rest.post(Routes.applicationCommands(client.application.id), { body: { ...command, integration_types: [0], contexts: [0, 1] } });
          }
          const globals = await client.rest.get(Routes.applicationCommands(client.application.id));
          for (const old of globals) if (old.type === 1 && old.name === 'dm') await client.rest.delete(Routes.applicationCommand(client.application.id, old.id));
          const existing = await client.rest.get(Routes.applicationGuildCommands(client.application.id, guildId));
          for (const old of existing) {
            if (stopped) return;
            if (old.type === 1 && [...commands.map(command => command.name), 'dm', 'prenumerera', 'avprenumerera', 'hjälp'].includes(old.name)) {
              await client.rest.delete(Routes.applicationGuildCommand(client.application.id, guildId, old.id));
            }
          }
          if (!stopped) { state('Igång'); report('Discord-boten är igång. /notifications on|off (dm:on|off), /status, /help, /language, /smtable och /card är registrerade för server och DM.'); }
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
