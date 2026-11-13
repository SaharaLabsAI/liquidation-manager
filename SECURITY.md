# Security policy

## Reporting a vulnerability

Report suspected vulnerabilities privately to **security@saharalabs.ai**. Do not open a public issue, pull request or
discussion for them.

Include what you can of:

- the affected contract, script or monitor component, and the commit, or the deployed address and chain;
- what an attacker can do and under which conditions;
- steps to reproduce it, ideally a Foundry test or a fork transaction.

## Scope

- The contracts in [`src/`](src/): `LiquidityManager`, `CCIPPoolAdapter`, `GuardianController`, `SaharaTimelock` and
  the `TokenBucket` library. Each carries this address as its `@custom:security-contact`.
- The deployment and handover scripts in [`script/`](script/).
- The read-only monitor in [`monitor/`](monitor/README.md).

Chainlink CCIP contracts (Router, ramps, TokenAdminRegistry, the `LockReleaseTokenPool` implementation) are maintained
by Chainlink: report issues in them to Chainlink as well.
