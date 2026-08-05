import type { Proposal as ContractProposal, SettlementInteraction } from "@byos/common";
import { type ContractInteraction, type CowOrder, encodeSettle } from "@byos/common";
import { type Address, concat, type Hex, keccak256, numberToHex, pad, toHex } from "viem";

export const DUMMY_SUBMITTER: Address = "0x1111111111111111111111111111111111111111";

/** Vendored AnyoneAuthenticator bytecode — returns true for all isSolver() calls. */
const ANYONE_AUTHENTICATOR_CODE: Hex =
	"0x6080604052348015600e575f5ffd5b50600436106026575f3560e01c806302cc250d14602a575b5f5ffd5b603b6035366004604f565b50600190565b604051901515815260200160405180910390f35b5f60208284031215605e575f5ffd5b813573ffffffffffffffffffffffffffffffffffffffff811681146080575f5ffd5b939250505056fea164736f6c634300081e000a";

/** keccak256("SUBMITTER_ROLE") — must match the Escrow contract. */
const SUBMITTER_ROLE: Hex = "0xe1a65d1a914580ff6931bc952f0fb26573e9282358a4458bceb9ccc6d923d041";

/**
 * Storage slot of AccessControl._roles mapping in the Escrow:
 * plain slot 5, after ERC20's five slots (non-upgradeable OZ v5 layout).
 */
const ROLES_MAPPING_SLOT = 5;

export interface SimulationParams {
	settlement: Address;
	authenticator: Address;
	escrow: Address;
	trampoline: Address;
	order: CowOrder;
	proposal: ContractProposal;
	route: readonly ContractInteraction[];
	signature: Hex;
	preInteractions: readonly SettlementInteraction[];
	postInteractions: readonly SettlementInteraction[];
}

export interface SimulationResult {
	calldata: Hex;
	stateOverride: Array<{
		address: Address;
		code?: Hex;
		stateDiff?: Array<{ slot: Hex; value: Hex }>;
	}>;
}

/**
 * Computes AccessControl._roles[SUBMITTER_ROLE].hasRole[account]:
 * keccak256(pad32(account) ‖ keccak256(pad32(role) ‖ pad32(5)))
 */
function submitterRoleSlot(account: Address): Hex {
	const roleDataSlot = keccak256(
		concat([SUBMITTER_ROLE, pad(numberToHex(ROLES_MAPPING_SLOT), { size: 32 })]),
	);
	return keccak256(concat([pad(account, { size: 32 }), roleDataSlot]));
}

/** Builds the simulation parameters for eth_estimateGas with state overrides. */
export function buildSimulation(params: SimulationParams): SimulationResult {
	const calldata = encodeSettle(
		params.order,
		params.proposal,
		params.trampoline,
		params.route,
		params.signature,
		params.preInteractions,
		params.postInteractions,
	);

	const slot = submitterRoleSlot(DUMMY_SUBMITTER);

	return {
		calldata,
		stateOverride: [
			{
				address: params.authenticator,
				code: ANYONE_AUTHENTICATOR_CODE,
			},
			{
				address: params.escrow,
				stateDiff: [{ slot, value: pad(toHex(1), { size: 32 }) }],
			},
		],
	};
}
