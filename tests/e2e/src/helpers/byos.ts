/**
 * BYOS proposal helpers: sign proposals, submit to BYOS API, poll status.
 */
import { randomBytes } from "node:crypto";
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
	options: { allowAuctionRetry?: boolean; returnFailure?: boolean } = {},
): Promise<{ id: number; response: Response }> {
	const signFn = makeSignFn(params.walletClient);
	const now = BigInt(Math.floor(Date.now() / 1000));
	const validUntil = now + BigInt(params.validUntilOffset ?? 240);
	const nonce = params.nonce ?? BigInt(`0x${randomBytes(16).toString("hex")}`);

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
		if (options.returnFailure) return { id: 0, response };
		const text = await response.clone().text();
		if (options.allowAuctionRetry && response.status === 400) {
			const error = JSON.parse(text) as { kind?: string; description?: string };
			if (
				error.kind === "UnknownOrder" ||
				error.kind === "NoActiveAuction" ||
				(error.kind === "ProposalRejected" && error.description === "AuctionClosed")
			)
				return { id: 0, response };
		}
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

/**
 * Follow real orderbook auctions until this order trades. Submit at most once
 * per auction, with a fresh nonce. An executing proposal blocks further bids.
 * The e2e stack already mines blocks; polling must not add another mining loop.
 */
export async function submitProposalUntilTrade(
	params: Omit<SubmitProposalParams, "nonce">,
	maxWaitMs = 90_000,
	onProgress?: (step: string) => void,
): Promise<{ id: number }> {
	const deadline = Date.now() + maxWaitMs;
	const ids: number[] = [];
	let submittedAuction: number | undefined;
	let executionStarted = false;
	let lastObservation = "waiting for auction admission";
	let tradeObserved = false;
	const observedStatuses = new Map<number, string>();
	onProgress?.("waiting for auction admission");
	try {
		while (Date.now() < deadline) {
			const tradesResponse = await fetch(
				`${CONFIG.orderbookUrl}/api/v1/trades?orderUid=${params.orderUid}`,
			);
			if (!tradesResponse.ok) throw new Error(`GET trades failed (${tradesResponse.status})`);
			const trades = (await tradesResponse.json()) as unknown[];
			if (trades.length > 0 && !tradeObserved) {
				tradeObserved = true;
				onProgress?.("trade indexed by orderbook");
			}

			for (const id of ids) {
				const proposal = await getProposal(params.walletClient, id);
				if (observedStatuses.get(id) !== proposal.status) {
					observedStatuses.set(id, proposal.status);
					onProgress?.(`proposal ${id}: ${proposal.status}`);
				}
				lastObservation = `proposal ${id}: ${proposal.status} (${proposal.rejectionReason ?? "no rejection reason"})`;
				if (proposal.status === "settled" && trades.length > 0) return { id };
				if (proposal.status === "executing" || proposal.status === "settled")
					executionStarted = true;
				if (["settleFailed", "penalized", "simFailed"].includes(proposal.status)) {
					throw new Error(`Settlement failed: ${lastObservation}`);
				}
				if (proposal.status === "rejected" && proposal.rejectionReason !== "AuctionClosed") {
					throw new Error(`Proposal rejected: ${lastObservation}`);
				}
			}

			if (!executionStarted && trades.length === 0) {
				const response = await fetch(`${CONFIG.orderbookUrl}/api/v1/auction`);
				if (!response.ok) throw new Error(`GET auction failed (${response.status})`);
				const auction = (await response.json()) as { id: number; orders: { uid: string }[] };
				if (
					auction.id !== submittedAuction &&
					auction.orders.some((order) => order.uid.toLowerCase() === params.orderUid.toLowerCase())
				) {
					onProgress?.(`order observed in auction ${auction.id}; submitting proposal`);
					const result = await signAndSubmitProposal(
						{ ...params, nonce: BigInt(`0x${randomBytes(16).toString("hex")}`) },
						{ allowAuctionRetry: true },
					);
					if (result.response.ok) {
						onProgress?.(`proposal ${result.id} admitted (HTTP ${result.response.status})`);
						ids.push(result.id);
						submittedAuction = auction.id;
					} else {
						lastObservation = await result.response.text();
						onProgress?.(`admission retry: ${lastObservation}`);
					}
				}
			}
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
		throw new Error(
			`Order ${params.orderUid} did not settle within ${maxWaitMs}ms; ${lastObservation}; proposal IDs: ${ids.join(", ")}`,
		);
	} finally {
		await cancelProposals(params.walletClient, ids);
		onProgress?.("proposal cleanup complete");
	}
}

/** Submit while an order is in the real auction; expose inline rejections to negative tests. */
export async function submitProposalInAuction(
	params: Omit<SubmitProposalParams, "nonce">,
	onProgress?: (step: string) => void,
	maxWaitMs = 30_000,
): Promise<{ id: number; response: Response }> {
	const deadline = Date.now() + maxWaitMs;
	let lastError = "order not yet in auction";
	while (Date.now() < deadline) {
		const auctionResponse = await fetch(`${CONFIG.orderbookUrl}/api/v1/auction`);
		if (!auctionResponse.ok) throw new Error(`GET auction failed (${auctionResponse.status})`);
		const auction = (await auctionResponse.json()) as { id: number; orders: { uid: string }[] };
		if (auction.orders.some((order) => order.uid.toLowerCase() === params.orderUid.toLowerCase())) {
			const result = await signAndSubmitProposal(
				{ ...params, nonce: BigInt(`0x${randomBytes(16).toString("hex")}`) },
				{ returnFailure: true },
			);
			if (result.response.ok) {
				onProgress?.(`proposal ${result.id} admitted in auction ${auction.id}`);
				return result;
			}
			const error = (await result.response.clone().json()) as {
				kind: string;
				description?: string;
			};
			lastError = JSON.stringify(error);
			if (
				!["UnknownOrder", "NoActiveAuction"].includes(error.kind) &&
				!(error.kind === "ProposalRejected" && error.description === "AuctionClosed")
			) {
				onProgress?.(`inline rejection: ${lastError}`);
				return result;
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(
		`Order ${params.orderUid}: admission timed out after ${maxWaitMs}ms; ${lastError}`,
	);
}

export interface BurstProposal {
	params: Omit<SubmitProposalParams, "nonce">;
	subSolverIndex: number;
	winner: boolean;
}

/** One auction read and one owner-list read per sub-solver, rather than N pollers. */
export async function submitProposalBurstUntilSettled(
	assignments: BurstProposal[],
	maxWaitMs: number,
	onProgress: (step: string) => void,
): Promise<(BurstProposal & { id: number })[]> {
	const deadline = Date.now() + maxWaitMs;
	const attempts: (BurstProposal & { id: number })[] = [];
	const wallets = new Map(assignments.map((a) => [a.subSolverIndex, a.params.walletClient]));
	const complete = new Map<string, BurstProposal & { id: number }>();
	const inFlight = new Set<string>();
	const orderUids = new Set(assignments.map((a) => a.params.orderUid));
	let latestStatuses = new Map<number, { status: string; rejectionReason?: string }>();
	let previousAuction: number | undefined;
	try {
		while (Date.now() < deadline) {
			const statuses = new Map<number, { status: string; rejectionReason?: string }>();
			latestStatuses = statuses;
			await Promise.all(
				[...wallets.values()].map(async (wallet) => {
					const signature = await signReadAuth(makeSignFn(wallet), DOMAIN);
					const response = await fetch(
						`${CONFIG.byosPublicUrl}/proposals/by-sub-solver?includeArchived=true`,
						{ headers: { "X-Signature": signature } },
					);
					if (!response.ok) throw new Error(`GET proposals failed (${response.status})`);
					const { proposals } = (await response.json()) as {
						proposals: { id: number; status: string; rejectionReason?: string }[];
					};
					for (const proposal of proposals) statuses.set(proposal.id, proposal);
				}),
			);
			for (const attempt of attempts) {
				const status = statuses.get(attempt.id);
				if (status?.status === "executing") inFlight.add(attempt.params.orderUid);
				if (status?.status === "settled") {
					if (!attempt.winner)
						throw new Error(`Worse quote settled for ${attempt.params.orderUid}`);
					complete.set(attempt.params.orderUid, attempt);
				}
				if (status && ["simFailed", "settleFailed", "penalized"].includes(status.status))
					throw new Error(
						`Proposal ${attempt.id}: ${status.status} ${status.rejectionReason ?? ""}`,
					);
			}
			if (complete.size === orderUids.size) {
				onProgress(`all ${complete.size} orders settled`);
				return [...complete.values()];
			}
			const response = await fetch(`${CONFIG.orderbookUrl}/api/v1/auction`);
			if (!response.ok) throw new Error(`GET auction failed (${response.status})`);
			const auction = (await response.json()) as { id: number; orders: { uid: string }[] };
			if (auction.id !== previousAuction) {
				previousAuction = auction.id;
				const available = new Set(auction.orders.map((o) => o.uid));
				const pending = assignments.filter(
					(a) =>
						available.has(a.params.orderUid) &&
						!complete.has(a.params.orderUid) &&
						!inFlight.has(a.params.orderUid),
				);
				let admitted = 0;
				await collectSubmissions(
					pending.map(async (assignment) => {
						const result = await signAndSubmitProposal(
							{ ...assignment.params, nonce: BigInt(`0x${randomBytes(16).toString("hex")}`) },
							{ returnFailure: true },
						);
						if (!result.response.ok) {
							const error = (await result.response.json()) as { kind: string; description: string };
							if (
								["NoActiveAuction", "UnknownOrder"].includes(error.kind) ||
								error.description === "AuctionClosed"
							)
								return null;
							throw new Error(`Burst proposal failed: ${JSON.stringify(error)}`);
						}
						return { ...assignment, id: result.id };
					}),
					(result) => {
						if (result) {
							attempts.push(result);
							admitted++;
						}
					},
				);
				onProgress(
					`auction ${auction.id}: ${admitted}/${pending.length} bids admitted; ${complete.size}/${orderUids.size} settled`,
				);
			}
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
		throw new Error(
			`${orderUids.size - complete.size}/${orderUids.size} burst orders did not settle within ${maxWaitMs}ms`,
		);
	} finally {
		await Promise.all(
			[...wallets].map(([index, wallet]) =>
				cancelProposals(
					wallet,
					attempts
						.filter(
							(a) =>
								a.subSolverIndex === index &&
								![
									"settled",
									"settleFailed",
									"penalized",
									"rejected",
									"cancelled",
									"expired",
									"simFailed",
								].includes(latestStatuses.get(a.id)?.status ?? "submitted"),
						)
						.map((a) => a.id),
				),
			),
		);
	}
}
