import { questionReplyParts } from './question-answer.mjs';
import { questionSearchHint } from './question-acknowledgement.mjs';

export async function deliverQuestion({ interaction, questions, log, language, flags, now = Date.now, cancelled = () => false }) {
  let id, parts = [], sent = 0, details = {}, acknowledgement = null;
  try {
    id = log.start({ userId: interaction.user.id, userName: interaction.member?.displayName || interaction.user.globalName || interaction.user.username,
      guildId: interaction.guildId, guildName: interaction.guild?.name, channelId: interaction.channelId, channelName: interaction.channel?.name,
      receivedAt: interaction.createdTimestamp, language, question: interaction.options.getString('question') });
    const started = now();
    let investigationStarted = started;
    const content = await questions.ask({ userId: interaction.user.id, question: interaction.options.getString('question'), language,
      async onAccepted() {
        if (cancelled()) throw new Error('Question cancelled.');
        acknowledgement = { ...questionSearchHint(interaction.options.getString('question'), language), delivery: 'unconfirmed' };
        log.update(id, { acknowledgement });
        await interaction.editReply({ content: acknowledgement.text, allowedMentions: { parse: [] }, flags: flags.SuppressEmbeds });
        acknowledgement.delivery = 'sent'; acknowledgement.sentAt = new Date(now()).toISOString();
        log.update(id, { acknowledgement, acknowledgementMs: Math.max(0, now() - (interaction.createdTimestamp ?? started)) });
        investigationStarted = now();
      },
      onAnswer(value) { details = value; }, onTelemetry(event) { log.telemetry(id, event); } });
    if (acknowledgement && acknowledgement.delivery !== 'sent') throw new Error('Acknowledgement delivery uncertain.');
    const texts = details.parts ?? questionReplyParts([content]);
    if (!Array.isArray(texts) || !texts.length || texts.length > 2 || texts.some(text => typeof text !== 'string' || !text || text.length > 2000)) throw new Error('Invalid Discord reply.');
    parts = texts.map(text => ({ text, delivery: 'pending' }));
    log.update(id, { ...details, parts, modelDurationMs: now() - investigationStarted, status: 'processing' });
    if (cancelled()) { log.finish(id, { status: 'interrupted', deliveryStatus: acknowledgement ? 'acknowledged' : 'not-sent' }); return; }
    for (let index = 0; index < parts.length; index++) {
      parts[index].delivery = 'unconfirmed'; log.update(id, { parts });
      const followup = !!acknowledgement || index > 0;
      const payload = { content: parts[index].text, allowedMentions: { parse: [] }, flags: flags.SuppressEmbeds | (followup && interaction.guildId ? flags.Ephemeral : 0) };
      if (!followup) await interaction.editReply(payload); else await interaction.followUp(payload);
      sent++; parts[index].delivery = 'sent'; parts[index].sentAt = new Date(now()).toISOString();
      log.update(id, { parts, ...(index === 0 ? { firstResponseMs: Math.max(0, now() - (interaction.createdTimestamp ?? started)) } : {}) });
    }
    log.finish(id, { status: details.status ?? 'denied', deliveryStatus: 'sent', failure: details.failure, parts });
  } catch {
    // Never overwrite an already delivered part or retry an uncertain delivery.
    if (id && log.available) {
      try { log.finish(id, { status: 'failed', deliveryStatus: sent ? 'partial' : parts.length || acknowledgement?.delivery === 'unconfirmed' ? 'unconfirmed' : acknowledgement ? 'acknowledged' : 'not-sent', failure: 'question_or_delivery_failed', parts }); }
      catch { /* A storage failure must not trigger another Discord delivery. */ }
    }
    if (!parts.length && !acknowledgement) await interaction.editReply({ content: language === 'sv-SE' ? 'Frågan kunde inte behandlas eller loggas just nu.' : 'The question could not be processed or logged right now.', allowedMentions: { parse: [] } }).catch(() => {});
  }
}
