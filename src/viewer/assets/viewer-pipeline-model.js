/**
 * llmwiki viewer — the `#/pipeline` panel's reachability model.
 *
 * The panel's one rule is that hue follows reachability, so this module owns
 * the reachability and nothing else: it turns a declared lifecycle plus a state
 * tally into an ordered list of states, each labelled with the role that decides
 * its treatment. Keeping it out of the renderer means the rule can be pinned by
 * tests as arithmetic rather than as DOM, and means the renderer never has a
 * second opinion about what "terminal" or "unreachable" means.
 *
 * Three roles, in the order the design derives them:
 *   - `terminal`    — the profile DECLARES it terminal. Declared, so it is teal.
 *   - `unreachable` — no path of declared transitions runs from `initial` to it,
 *                     or it is not a declared value of the lifecycle field at
 *                     all. Either way the lifecycle cannot produce it.
 *   - `flight`      — everything else: reached, still moving.
 *
 * A lifecycle that declares NO terminal state and NO transition edge orders
 * nothing, so every state stays `flight` and nothing is called unreachable —
 * "not declared" is not the same finding as "declared and unreachable", and
 * inventing an order where none exists would be the worse error.
 */

/**
 * Violet alpha stops for `flight` states of a type whose transitions DO order
 * them, in chain order. The first two are the mockup's literals; the tail
 * continues the descent for a longer chain and then holds, so a nine-state
 * lifecycle stays legible instead of fading into its own track.
 */
const ORDERED_RAMP = [1, 0.55, 0.4, 0.3];

/**
 * The same for a type with no derivable order. A flatter second stop (the
 * mockup's literal) because these steps separate adjacent bar segments — they
 * are not a sequence, and a steep ramp would read as one.
 */
const NEUTRAL_RAMP = [1, 0.45, 0.35, 0.3];

/** Alpha for an unreachable state's swatch — the mockup's `rgba(danger, .55)`. */
const UNREACHABLE_ALPHA = 0.55;

/** Terminal and unreachable states are drawn at full strength, not ramped. */
const FULL_ALPHA = 1;

/** True when the lifecycle declares anything that puts its states in an order. */
export function hasDeclaredOrder(lifecycle) {
  if (!lifecycle) return false;
  return terminalStates(lifecycle).length > 0 || transitionEdgeCount(lifecycle) > 0;
}

/** The declared terminal states, defended against a malformed payload. */
function terminalStates(lifecycle) {
  return Array.isArray(lifecycle?.terminal) ? lifecycle.terminal : [];
}

/** How many state→state edges the transition graph actually declares. */
function transitionEdgeCount(lifecycle) {
  return Object.values(lifecycle?.transitions ?? {}).reduce(
    (total, targets) => total + (Array.isArray(targets) ? targets.length : 0),
    0,
  );
}

/**
 * The states reachable from `initial`, in the order the declared transitions
 * reach them — breadth-first, so a fork renders nearest-first rather than
 * following whichever branch happened to be listed first all the way down.
 *
 * This, and never the enum, is where the chain comes from: the enum is a set of
 * legal values whose order is an accident of how the profile was written.
 *
 * @param {{initial?: string, transitions?: Record<string, string[]>}} lifecycle
 * @returns {string[]}
 */
export function reachableOrder(lifecycle) {
  const initial = lifecycle?.initial;
  return typeof initial === "string" ? walkFrom(lifecycle, initial) : [];
}

/** Drain the transition graph breadth-first from one starting state. */
function walkFrom(lifecycle, initial) {
  const order = [];
  const seen = new Set();
  const queue = [initial];
  while (queue.length > 0) {
    const state = queue.shift();
    if (seen.has(state)) continue;
    seen.add(state);
    order.push(state);
    queue.push(...outgoing(lifecycle, state));
  }
  return order;
}

/** The states one state transitions to, defended against a malformed payload. */
function outgoing(lifecycle, state) {
  const targets = lifecycle.transitions?.[state];
  return Array.isArray(targets) ? targets : [];
}

/**
 * Classify and order every TALLIED state of one entity type.
 *
 * Only states with pages in them are classified. The renderer adds zero-count
 * declared states separately, without producing warnings about absent records.
 *
 * @param {object|undefined} lifecycle - The declared lifecycle, if any.
 * @param {Record<string, number>|undefined} stateCounts - The unfiltered tally.
 * @returns {{state: string, count: number, role: string, alpha: number}[]}
 */
export function classifyStates(lifecycle, stateCounts) {
  const tallied = Object.entries(stateCounts ?? {}).filter(([, count]) => count > 0);
  const ordered = hasDeclaredOrder(lifecycle);
  // The chain is walked ONCE and threaded through both steps below: it decides
  // each state's role and its reading position, and those two must agree.
  const chain = ordered ? reachableOrder(lifecycle) : [];
  const roles = new Map(tallied.map(([state]) => [state, roleOf(state, lifecycle, chain, ordered)]));
  return withRampAlpha(sortStates(tallied, chain), roles, ordered ? ORDERED_RAMP : NEUTRAL_RAMP);
}

/** The role one tallied state takes; every state of an orderless type is `flight`. */
function roleOf(state, lifecycle, chain, ordered) {
  if (!ordered) return "flight";
  if (terminalStates(lifecycle).includes(state)) return "terminal";
  return chain.includes(state) ? "flight" : "unreachable";
}

/**
 * Reading order: the chain first, exactly as the transitions run it, then the
 * states the chain never arrives at, biggest pile first. A type with no chain
 * falls back to biggest pile first throughout — the only ordering left that is
 * a fact about the project rather than an invention.
 */
function sortStates(tallied, chain) {
  const rank = (state) => {
    const index = chain.indexOf(state);
    return index === -1 ? chain.length : index;
  };
  return [...tallied].sort(([aState, aCount], [bState, bCount]) => {
    const byChain = rank(aState) - rank(bState);
    return byChain !== 0 ? byChain : bCount - aCount;
  });
}

/** Attach each state's fill strength: ramped along the chain, full otherwise. */
function withRampAlpha(sorted, roles, ramp) {
  let step = 0;
  return sorted.map(([state, count]) => {
    const role = roles.get(state);
    if (role !== "flight") return { state, count, role, alpha: alphaForRole(role) };
    const alpha = ramp[Math.min(step, ramp.length - 1)];
    step += 1;
    return { state, count, role, alpha };
  });
}

/** Fill strength for a non-`flight` role. */
function alphaForRole(role) {
  return role === "unreachable" ? UNREACHABLE_ALPHA : FULL_ALPHA;
}
