/**
 * BYOS proposal helpers: sign proposals, submit to BYOS API, poll status.
 */
import type { ContractInteraction } from "@byos/common";
import { byosDomain, signCancellation, signProposal, signReadAuth } from "@byos/common";
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
	nonce?: bigint; // override the default timestamp-based nonce
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
	const nonce = params.nonce ?? now; // use timestamp as nonce for uniqueness

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
 * Cancel all non-terminal proposals owned by the sub-solver.
 * Call this at the start of a test run to evict stale proposals from previous runs.
 * Proposals that are already in a terminal state are silently skipped.
 */
export async function cancelAllActiveProposals(walletClient: WalletClient): Promise<void> {
	const signFn = makeSignFn(walletClient);
	const sig = await signReadAuth(signFn, DOMAIN);

	const resp = await fetch(`${CONFIG.byosPublicUrl}/proposals/by-sub-solver`, {
		headers: { "X-Signature": sig },
	});
	if (!resp.ok) {
		const text = await resp.text();
		throw new Error(`GET /proposals/by-sub-solver failed (${resp.status}): ${text}`);
	}

	const { proposals } = (await resp.json()) as { proposals: Array<{ id: number; status: string }> };
	const TERMINAL = new Set([
		"settled",
		"settleFailed",
		"penalized",
		"rejected",
		"simFailed",
		"expired",
		"cancelled",
	]);
	const active = proposals.filter((p) => !TERMINAL.has(p.status));

	await Promise.all(
		active.map(async (p) => {
			const cancelSig = await signCancellation(signFn, DOMAIN, BigInt(p.id));
			const r = await fetch(`${CONFIG.byosPublicUrl}/proposal/${p.id}`, {
				method: "DELETE",
				headers: { "X-Signature": cancelSig },
			});
			// 204 = cancelled, 202 = deferred (executing), 404/409 = already gone — all fine
			if (!r.ok && r.status !== 404 && r.status !== 409) {
				const text = await r.text();
				throw new Error(`DELETE /proposal/${p.id} failed (${r.status}): ${text}`);
			}
		}),
	);
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
	let lastStatus = "unobserved";
	let lastError = "none";
	while (Date.now() - start < maxWaitMs) {
		try {
			const proposal = await getProposal(walletClient, proposalId);
			lastStatus = `${proposal.status} (${proposal.rejectionReason ?? "no rejection reason"})`;
			if (targetStatuses.includes(proposal.status)) {
				return proposal;
			}
		} catch (error) {
			lastError = String(error);
		}
		await new Promise((r) => setTimeout(r, 1000));
	}
	throw new Error(
		`Proposal ${proposalId} did not reach ${targetStatuses.join("/")} within ${maxWaitMs}ms; last status: ${lastStatus}; last error: ${lastError}`,
	);
}

/** Cancel only proposals created by this test. */
export async function cancelProposals(walletClient: WalletClient, ids: number[]): Promise<void> {
	for (const id of ids) {
		const signature = await signCancellation(makeSignFn(walletClient), DOMAIN, BigInt(id));
		const response = await fetch(`${CONFIG.byosPublicUrl}/proposal/${id}`, {
			method: "DELETE",
			headers: { "X-Signature": signature },
		});
		if (
			!response.ok &&
			response.status !== 404 &&
			response.status !== 409 &&
			response.status !== 429
		)
			throw new Error(`Cleanup proposal ${id}: ${response.status}`);
	}
}

/** Wait for the whole submission burst before cleanup, retaining partial successes. */
export async function collectSubmissions<T>(
	requests: Promise<T>[],
	onSuccess: (value: T) => void,
): Promise<T[]> {
	const results = await Promise.allSettled(requests);
	const values: T[] = [];
	const errors: unknown[] = [];
	for (const result of results) {
		if (result.status === "fulfilled") {
			values.push(result.value);
			onSuccess(result.value);
		} else errors.push(result.reason);
	}
	if (errors.length) {
		const details = errors
			.slice(0, 3)
			.map((error) => (error instanceof Error ? error.message : String(error)));
		throw new AggregateError(
			errors,
			`Submission burst failed (${errors.length}): ${details.join("; ")}`,
		);
	}
	return values;
}
