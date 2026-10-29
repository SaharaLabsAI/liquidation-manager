// The rule lists the daemon runs. Event rules see every scanned chunk, in this order, with the union of their logs;
// state rules run at the confirmed head and are synced per rule under `${chain}:${rule.id}:`.
import {ccipEventsRule} from "../ccip/tracker.ts";
import type {EventRule, StateRule} from "../types.ts";
import {eventRules as contractEventRules} from "./events.ts";
import {flowsRule} from "./flows.ts";
import {stateRules as contractStateRules} from "./state.ts";
import {timelockEventsRule, timelockQueueRule} from "./timelock.ts";

/**
 * Every event rule. The Timelock rule runs first, so an operation scheduled and cancelled within one chunk is already
 * in its store (`timelock:${chain}`) when the controller rule describes the Guardian's ProposalCancelled.
 */
export const eventRules: EventRule[] = [timelockEventsRule, ...contractEventRules, flowsRule, ccipEventsRule];

/** Every state rule: the contract checks of state.ts and the Timelock queue. */
export const stateRules: StateRule[] = [...contractStateRules, timelockQueueRule];

/**
 * Rules replayed (muted) from `startBlock` on a fresh state file. Of the history, what must be known is the Timelock
 * operations still pending and the CCIP messages still in flight or failed; replaying everything would re-page every
 * historical critical/high event.
 */
export const backfillRules: EventRule[] = [timelockEventsRule, ccipEventsRule];
