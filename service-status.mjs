import { DiscordDeliveryError } from './discord.mjs';

export function serviceStatusMessage(running) {
  return {
    username: 'Nations',
    content: running ? '🟢 Bevakningen har startat.' : '⚪ Bevakningen har stängts av.',
    allowed_mentions: { parse: [], users: [], roles: [] },
  };
}

// Status is best-effort and never persisted: a delayed startup notice must not
// be replayed after the service has already stopped.
export class ServiceStatus {
  constructor(send, report = () => {}) {
    this.send = send; this.report = report;
    this.startAbort = new AbortController();
  }
  start() {
    if (this.stopping) return Promise.resolve();
    this.startPromise ??= this.deliver(true, AbortSignal.any([this.startAbort.signal, AbortSignal.timeout(15000)]));
    return this.startPromise;
  }
  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.startAbort.abort();
    this.stopPromise = (async () => {
      await this.startPromise;
      await this.deliver(false, AbortSignal.timeout(15000));
    })();
    return this.stopPromise;
  }
  async deliver(running, signal) {
    try { await this.send(serviceStatusMessage(running), signal); }
    catch (error) {
      const detail = error instanceof DiscordDeliveryError ? ' ' + error.message : '';
      this.report(`${running ? 'Uppstartsmeddelandet' : 'Nedstängningsmeddelandet'} kunde inte bekräftas.${detail}`);
    }
  }
}
