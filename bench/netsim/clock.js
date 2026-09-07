/**
 * @file A virtual clock, so network experiments are fast and reproducible.
 *
 * Simulating a three-minute partition on a 500ms-RTT link should not take
 * three minutes. And a benchmark whose numbers move because the machine was
 * busy is not a measurement, it is an anecdote -- which matters here, because
 * the results are the evidence for the design.
 *
 * So simulated time is a number this class advances, not wall time. Events are
 * processed in timestamp order; between them the real microtask queue is
 * drained so ordinary `async`/`await` code runs to completion at each step.
 * The engine under test is entirely unaware: it receives `setTimeout` and
 * `now` through injection and cannot tell the difference.
 *
 * The result is deterministic given a seed. A failing run replays exactly.
 */

/** Let every pending promise callback run before advancing simulated time. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

export class VirtualClock {
  #now = 0;
  #seq = 0;
  /** @type {Array<{at: number, seq: number, fn: Function, cancelled: boolean}>} */
  #queue = [];

  get now() { return this.#now; }
  get pending() { return this.#queue.filter((e) => !e.cancelled).length; }

  /** Drop-in for `Date.now`. */
  readonly = () => this.#now;

  /** Drop-in for `setTimeout`, returning a cancellable handle. */
  setTimeout = (fn, ms = 0) => {
    const entry = { at: this.#now + Math.max(0, ms), seq: this.#seq++, fn, cancelled: false };
    this.#queue.push(entry);
    return entry;
  };

  clearTimeout = (handle) => { if (handle) handle.cancelled = true; };

  /** Await a simulated delay. */
  sleep(ms) { return new Promise((resolve) => this.setTimeout(resolve, ms)); }

  /** The timer trio the sync engine takes by injection. */
  get timers() {
    return { setTimeout: this.setTimeout, clearTimeout: this.clearTimeout, now: this.readonly };
  }

  #next() {
    let best = -1;
    for (let i = 0; i < this.#queue.length; i++) {
      const e = this.#queue[i];
      if (e.cancelled) continue;
      const b = this.#queue[best];
      if (best === -1 || e.at < b.at || (e.at === b.at && e.seq < b.seq)) best = i;
    }
    return best;
  }

  /**
   * Run scheduled events in time order, up to `untilMs`.
   *
   * Never advances the clock past the last event it actually ran, so elapsed
   * time reflects work performed rather than the size of the budget. Use
   * {@link VirtualClock#advance} when the intent really is "let time pass".
   *
   * @returns {Promise<number>} simulated time elapsed
   */
  async run({ untilMs = Infinity, maxEvents = 1_000_000 } = {}) {
    const started = this.#now;
    let processed = 0;

    // Anything already in flight must settle before the first jump, or we
    // would skip past work that was about to schedule a timer.
    await flush();

    while (processed < maxEvents) {
      const i = this.#next();
      if (i === -1) break;
      const entry = this.#queue[i];
      if (entry.at > untilMs) break;

      this.#queue.splice(i, 1);
      this.#now = Math.max(this.#now, entry.at);
      entry.fn();
      processed++;
      await flush();
    }
    return this.#now - started;
  }

  /** Let `ms` of simulated time pass, running everything scheduled within it. */
  async advance(ms) {
    const target = this.#now + ms;
    await this.run({ untilMs: target });
    this.#now = Math.max(this.#now, target);
    return ms;
  }

  /**
   * Run the clock until `promise` settles.
   *
   * This is the bridge between the code under test -- which is ordinary
   * `async` code awaiting timers -- and simulated time, which only moves when
   * something drives it. Without it, the first `await clock.sleep()` inside
   * the sync engine would deadlock: nobody is advancing the clock that would
   * resolve it.
   *
   * Stops early if the promise is still pending with nothing scheduled, which
   * means the code is waiting on something the simulation will never provide.
   *
   * @template T @param {Promise<T>} promise @returns {Promise<T>}
   */
  async drive(promise, { budgetMs = 30 * 60_000 } = {}) {
    let settled = false;
    const watched = promise.then(
      (v) => { settled = true; return v; },
      (e) => { settled = true; throw e; },
    );
    // Swallow here; the caller sees the rejection when it awaits `watched`.
    watched.catch(() => {});

    const deadline = this.#now + budgetMs;
    while (!settled) {
      await this.run({ untilMs: deadline });
      if (settled) break;
      if (this.pending === 0 || this.#now >= deadline) break;
    }
    return watched;
  }

  reset() { this.#now = 0; this.#seq = 0; this.#queue.length = 0; }
}
