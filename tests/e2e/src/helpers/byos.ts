/**
 * BYOS proposal helpers: sign proposals, submit to BYOS API, poll status.
 */
import type { ContractInteraction } from "@byos/common";
import { byosDomain, signProposal, signReadAuth } from "@byos/common";
import type { Address, Hex, WalletClient } from "viem";
import { keccak256 } from "viem";
import { CONFIG, CONTRACTS } from "./config.js";

const DOMAIN = byosDomain(CONFIG.chainId, CONTRACTS.trampolineFactory);

function makeSignFn(client: WalletClient) {
	return (params: any) => client.signTypedData(params);
}

export interface SubmitProposalParams {
	walletClient: WalletClient;
	orderUid: string;
	sellToken: Address;
	buyToken: Address;
	sellAmount: bigint;
	minBuyAmount: bigint;
	quoteBuyAmount: bigint;
	interactions: ContractInteraction[];
	validUntilOffset?: number; // seconds from now, default 240
}

/**
 * Sign and submit a BYOS proposal. Returns the proposal ID.
 */
export async function signAndSubmitProposal(
	params: SubmitProposalParams,
): Promise<{ id: number; response: Response }> {
	const signFn = makeSignFn(params.walletClient);
	const now = BigInt(Math.floor(Date.now() / 1000));
	const validUntil = now + BigInt(params.validUntilOffset ?? 240);
	const nonce = now; // use timestamp as nonce for uniqueness

	const orderUidHash = keccak256(params.orderUid as Hex);
	const proposal = {
		orderUidHash,
		sellToken: params.sellToken,
		buyToken: params.buyToken,
		sellAmount: params.sellAmount,
		minBuyAmount: params.minBuyAmount,
		quoteBuyAmount: params.quoteBuyAmount,
		validUntil,
		nonce,
	};

	const signature = await signProposal(signFn, DOMAIN, proposal, params.interactions);

	const body = {
		orderUid: params.orderUid,
		sellToken: params.sellToken,
		buyToken: params.buyToken,
		sellAmount: params.sellAmount.toString(),
		minBuyAmount: params.minBuyAmount.toString(),
		quoteBuyAmount: params.quoteBuyAmount.toString(),
		interactions: params.interactions.map((i) => ({
			target: i.target,
			value: i.value.toString(),
			callData: i.callData,
		})),
		validUntil: validUntil.toString(),
		nonce: nonce.toString(),
		signature,
	};

	const response = await fetch(`${CONFIG.byosPublicUrl}/proposals`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Proposal submission failed (${response.status}): ${text}`);
	}

	const { id } = (await response.json()) as { id: number };
	return { id, response };
}

/**
 * GET a proposal by ID (owner-scoped, requires signature).
 */
export async function getProposal(
	walletClient: WalletClient,
	proposalId: number,
): Promise<{ status: string; settlementTxHash?: string; [key: string]: unknown }> {
	const signFn = makeSignFn(walletClient);
	const sig = await signReadAuth(signFn, DOMAIN);

	const resp = await fetch(`${CONFIG.byosPublicUrl}/proposal/${proposalId}`, {
		headers: { "X-Signature": sig },
	});

	if (!resp.ok) {
		const text = await resp.text();
		throw new Error(`GET proposal/${proposalId} failed (${resp.status}): ${text}`);
	}

	return resp.json() as Promise<{ status: string; [key: string]: unknown }>;
}

/**
 * POST directly to the internal /solve endpoint.
 */
export async function postSolve(auction: unknown): Promise<{ status: number; body: unknown }> {
	const resp = await fetch(`${CONFIG.byosInternalUrl}/solve`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(auction),
	});
	const body = await resp.json();
	return { status: resp.status, body };
}

/**
 * POST directly to the internal /notify endpoint.
 */
export async function postNotify(
	notification: unknown,
): Promise<{ status: number; body: unknown }> {
	const resp = await fetch(`${CONFIG.byosInternalUrl}/notify`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(notification),
	});
	const body = await resp.json();
	return { status: resp.status, body };
}

/**
 * Poll BYOS for proposal status until it matches one of the target statuses.
 */
export async function waitForProposalStatus(
	walletClient: WalletClient,
	proposalId: number,
	targetStatuses: string[],
	maxWaitMs = 30_000,
): Promise<{ status: string; [key: string]: unknown }> {
	const start = Date.now();
	while (Date.now() - start < maxWaitMs) {
		try {
			const proposal = await getProposal(walletClient, proposalId);
			if (targetStatuses.includes(proposal.status)) {
				return proposal;
			}
		} catch {
			// proposal might not exist yet, keep polling
		}
		await new Promise((r) => setTimeout(r, 1000));
	}
	throw new Error(
		`Proposal ${proposalId} did not reach ${targetStatuses.join("/")} within ${maxWaitMs}ms`,
	);
}
