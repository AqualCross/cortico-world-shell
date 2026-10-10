/** Shared fake WorldHost for tests: records pushed events, everything else is inert. */
import type { EventEnvelope, PushOptions, WorldHost } from 'cortico/core/types.ts';

export class FakeHost implements WorldHost {
  events: EventEnvelope[] = [];
  pushOpts: Array<PushOptions | undefined> = [];
  store = {
    get: () => undefined,
    latestCursor: () => 0,
    range: () => [],
    around: () => [],
    grep: () => [],
  } as unknown as WorldHost['store'];
  blob = (_handle: string): { bytes: Uint8Array; mime: string } | null => null;
  modelFacts = { model: () => 'test', accepts: () => false, contextWindow: () => 128000 };
  log = {
    child() { return this; },
    info() {}, warn() {}, error() {}, debug() {}, trace() {}, emit() {},
  } as unknown as WorldHost['log'];

  async pushEvent(e: Omit<EventEnvelope, 'cursor'>, opts?: PushOptions): Promise<EventEnvelope> {
    const full = { ...e, cursor: this.events.length + 1 } as EventEnvelope;
    this.events.push(full);
    this.pushOpts.push(opts);
    return full;
  }
  pushDeferred(): void {}
  async drainPendingEvents(): Promise<EventEnvelope[]> { return []; }
  reportUsage(): void {}
}
