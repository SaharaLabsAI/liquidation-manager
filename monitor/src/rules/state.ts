// State rules: every cycle each rule reads live configuration at the confirmed block and returns the conditions that
// currently violate the expected deployment (src/config.ts `expected`, with the Manager-era defaults). The daemon syncs
// them per rule (`alerter.sync(`${chain}:${rule.id}:`, conditions)`), so a condition stays open while it holds and is
// resolved once it clears. Rules whose contracts are not configured or resolved return nothing.
//
// Plumbing (failed reads, revert decoding, carry-forward of open conditions) lives in state-common.ts; the rules are
// grouped by contract in state-external.ts, state-pool.ts, state-manager.ts and state-governance.ts.
import type {StateRule} from "../types.ts";
import {registryStateRule, routerStateRule, tokenStateRule} from "./state-external.ts";
import {controllerStateRule, timelockStateRule} from "./state-governance.ts";
import {adapterStateRule, inventoryStateRule, managerStateRule} from "./state-manager.ts";
import {poolStateRule} from "./state-pool.ts";

export {decodeRevert, type Revert} from "./state-common.ts";
export {
  REGISTRY_RULE,
  ROUTER_RULE,
  TOKEN_RULE,
  registryStateRule,
  routerStateRule,
  tokenStateRule,
} from "./state-external.ts";
export {CONTROLLER_RULE, TIMELOCK_RULE, controllerStateRule, timelockStateRule} from "./state-governance.ts";
export {
  ADAPTER_RULE,
  INVENTORY_RULE,
  MANAGER_RULE,
  adapterStateRule,
  inventoryStateRule,
  managerStateRule,
} from "./state-manager.ts";
export {POOL_RULE, poolStateRule} from "./state-pool.ts";

/** Ids: state-token, state-registry, state-pool, state-manager, state-adapter, state-inventory, state-router,
 * state-timelock, state-controller. */
export const stateRules: StateRule[] = [
  tokenStateRule,
  registryStateRule,
  poolStateRule,
  managerStateRule,
  adapterStateRule,
  inventoryStateRule,
  routerStateRule,
  timelockStateRule,
  controllerStateRule,
];
