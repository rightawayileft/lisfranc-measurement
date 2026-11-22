import { SharedReviewError } from './shared.js';

// The server grants 120 seconds measured with its own clock. Stop trusting a
// local claim sooner, measured from request start with a monotonic clock.
const LOCAL_VALIDITY_MS = 110_000;
const noClaim = { claim: null, held: false, busy: false, retryClaim: false, error: null };

export function createStudyLease(store, studyUID, { newId = () => globalThis.crypto.randomUUID(), now = () => performance.now() } = {}) {
  const subscribers = new Set();
  let state = noClaim;
  let leaseId;
  let verifiedUntil = 0;
  let claimFlight;
  let writeFlight;
  let releaseFlight;
  let editorActive = false;
  let generation = 0;

  function publish(changes) {
    state = { ...state, ...changes };
    subscribers.forEach(listener => listener(state));
  }

  function forgetClaim() {
    verifiedUntil = 0;
    publish({ held: false });
  }

  async function observe(signal) {
    if (claimFlight || releaseFlight) return;
    const ticket = ++generation;
    let claim;
    try {
      claim = await store.getClaim(studyUID, signal);
    } catch (failure) {
      if (ticket !== generation || signal?.aborted) return;
      const retryClaim = state.held || state.retryClaim;
      forgetClaim();
      publish({ retryClaim, error: failure });
      return;
    }
    if (ticket !== generation || signal?.aborted) return;
    const sameClaim = claim !== null && claim.holder === state.claim?.holder && claim.expiresAt === state.claim?.expiresAt;
    const held = sameClaim && state.held && now() < verifiedUntil;
    if (!held) verifiedUntil = 0;
    const retryClaim = sameClaim && state.retryClaim;
    publish({ claim, held, retryClaim, error: retryClaim ? state.error : null });
  }

  async function acquire(renew = false) {
    if (releaseFlight) throw new SharedReviewError(0, 'Wait until the previous study claim is released.');
    if (claimFlight) return claimFlight;
    if (!renew && state.held && now() < verifiedUntil) return leaseId;
    if (!leaseId) leaseId = newId();
    generation++;
    const started = now();
    publish({ busy: true, error: null });
    claimFlight = (async () => {
      try {
        const claim = await store.claim(studyUID, leaseId);
        verifiedUntil = started + LOCAL_VALIDITY_MS;
        publish({ claim, held: !releaseFlight, retryClaim: false });
        return leaseId;
      } catch (failure) {
        forgetClaim();
        publish({ retryClaim: failure.status === 0 || failure.status >= 500, error: failure });
        throw failure;
      }
    })();
    try {
      return await claimFlight;
    } finally {
      claimFlight = null;
      if (!releaseFlight) publish({ busy: false });
    }
  }

  async function run(write) {
    if (writeFlight || releaseFlight) throw new SharedReviewError(0, 'A previous review save is still being confirmed.');
    writeFlight = (async () => write(await acquire()))();
    try {
      return await writeFlight;
    } catch (failure) {
      if (failure.code === 'claim_required') {
        forgetClaim();
        publish({ retryClaim: true });
      }
      throw failure;
    } finally {
      writeFlight = null;
    }
  }

  async function release({ keepalive = false } = {}) {
    if (releaseFlight) return releaseFlight;
    if (!leaseId) return;
    generation++;
    forgetClaim();
    publish({ busy: true, error: null, retryClaim: false });
    releaseFlight = (async () => {
      // Never release while a frame write might still use this lease. Other
      // tabs use a different token, even for the same signed-in reviewer.
      await Promise.allSettled([claimFlight, writeFlight]);
      try {
        const claim = await store.release(studyUID, leaseId, { keepalive });
        leaseId = undefined;
        publish({ claim, held: false });
      } catch (failure) {
        publish({ retryClaim: failure.status === 0 || failure.status >= 500, error: failure });
      }
    })();
    try {
      await releaseFlight;
    } finally {
      releaseFlight = null;
      publish({ busy: false });
    }
  }

  return {
    studyUID, observe, acquire, run, release,
    current: () => state,
    setEditing(active) { editorActive = active; },
    isEditing: () => editorActive,
    subscribe(listener) {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
  };
}

export const emptyClaimState = noClaim;
