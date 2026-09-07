/**
 * @file Named network profiles.
 *
 * These are the conditions the design is actually meant for, written down so
 * results are comparable across runs and so the numbers in the evaluation can
 * be tied to a stated model rather than a vague "slow connection".
 *
 * Values are drawn from commonly reported measurements for each link type.
 * They are a *model*, not a capture of any specific network: the point is a
 * reproducible spread from excellent to barely usable, with the two middle
 * rows representing the conditions this work is aimed at.
 *
 * `rttMs` is the round trip; `jitterMs` is the plus-or-minus spread on it.
 * `bandwidthBps` is bits per second, one direction. `loss` is the probability
 * a request is dropped outright and has to time out.
 */

/**
 * @typedef {object} NetworkProfile
 * @property {string} name
 * @property {string} description
 * @property {number} rttMs
 * @property {number} jitterMs
 * @property {number} bandwidthBps
 * @property {number} loss probability in [0, 1]
 * @property {{ everyMs: number, forMs: number }} [outage] recurring disconnection
 */

/** @type {Record<string, NetworkProfile>} */
export const PROFILES = {
  lan: {
    name: 'lan',
    description: 'Wired LAN. The control case: latency is not the constraint.',
    rttMs: 1, jitterMs: 0, bandwidthBps: 100e6, loss: 0,
  },
  broadband: {
    name: 'broadband',
    description: 'Home fixed-line broadband.',
    rttMs: 25, jitterMs: 5, bandwidthBps: 20e6, loss: 0.0001,
  },
  hostelWifi: {
    name: 'hostel-wifi',
    description:
      'Shared access point, heavily contended: high jitter, frequent brief '
      + 'outages as clients roam and the channel saturates. The motivating case.',
    rttMs: 80, jitterMs: 120, bandwidthBps: 2e6, loss: 0.03,
    outage: { everyMs: 90_000, forMs: 15_000 },
  },
  mobile3g: {
    name: 'mobile-3g',
    description: 'Mobile data with a usable signal.',
    rttMs: 200, jitterMs: 100, bandwidthBps: 1e6, loss: 0.015,
  },
  mobileEdge: {
    name: 'mobile-edge',
    description:
      'Edge-of-coverage mobile data: half-second round trips, a bandwidth cap '
      + 'that makes every byte count, and losses frequent enough that retries '
      + 'are the normal path rather than the exception.',
    rttMs: 500, jitterMs: 250, bandwidthBps: 128e3, loss: 0.05,
    outage: { everyMs: 60_000, forMs: 20_000 },
  },
  satellite: {
    name: 'satellite',
    description: 'Geostationary link: bandwidth is fine, latency is physics.',
    rttMs: 600, jitterMs: 40, bandwidthBps: 5e6, loss: 0.005,
  },
};

/** Profiles in the order results should be presented: best link to worst. */
export const PROFILE_ORDER = ['lan', 'broadband', 'satellite', 'mobile3g', 'hostelWifi', 'mobileEdge'];

/** @param {string} name @returns {NetworkProfile} */
export function profile(name) {
  const p = PROFILES[name];
  if (!p) throw new Error(`unknown network profile: ${name} (have ${Object.keys(PROFILES).join(', ')})`);
  return p;
}

/** Human-readable bandwidth, for tables. */
export function formatBandwidth(bps) {
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(bps % 1e6 ? 1 : 0)} Mbps`;
  return `${Math.round(bps / 1e3)} kbps`;
}
