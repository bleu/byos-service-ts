# Optional gas profitability

Status: accepted

Spec: docs/shared/design-document.md#scoring
      docs/shared/design-document.md#the-gas-cut

## Context

ADR-0002 and ADR-0013 assume proposals must cover settlement gas out of the
order's surplus. That default prevents an operator from funding gas to execute
otherwise valid routes with a small positive surplus.

## Decision

Reopen those decisions to allow an explicit deployment opt-out through
`USE_GAS_PROFITABILITY`, defaulting to `true`. The normative behavior is specified
in the companion shared specification change. Both validation and selection must
use the same setting: changing validation alone leaves the route excluded at
`/solve`, and retaining the gas cut would still breach the signed limit.

The opt-out is confined to scoring and gas recovery. Gas remains relevant to
simulation, driver gas estimates, and collateral exposure, so those calculations
continue to use the real gas cost. The minimum proposal score continues to apply
to the score calculated in the chosen mode.

## Consequences

An operator opting out accepts paying settlement gas without recovering it
through the gas cut. The driver still performs its own simulation and selection;
passing BYOS validation does not guarantee execution.

All replicas in a deployment should use the same setting. Previously rejected
proposals remain terminal and must be resubmitted after changing the setting.
