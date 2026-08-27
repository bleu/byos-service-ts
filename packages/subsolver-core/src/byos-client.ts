import { isTerminalStatus, signCancellation, signReadAuth } from "@byos/common";
import type { Hex, TypedDataDomain } from "viem";
import type { SignedProposal } from "./proposal.js";

// biome-ignore lint/suspicious/noExplicitAny: viem's signTypedData is overloaded.
type SignFn = (params: any) => Promise<Hex>;

interface ProposalView {
	id: number;
	status: string;
	rejectionReason?: string;
}

export interface ProposalMetadata {
	id: number;
	orderUid: Hex;
	validUntil: bigint;
	status: string;
}

/** Explicit API rate limit, preserving the Retry-After supplied by BYOS. */
export class ByosRateLimitError extends Error {
	constructor(readonly retryAfterMs: number) {
		super("BYOS request budget exhausted");
	}
}

function rateLimitError(response: Response): ByosRateLimitError {
	const seconds = Number(response.headers.get("Retry-After") ?? "1");
	return new ByosRateLimitError(Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 1000);
}

/** Reusable authenticated BYOS proposal API client. */
export class ByosClient {
	private cachedReadAuth: Hex | null = null;
	private readonly baseUrl: string;

	constructor(
		baseUrl: string,
		private readonly domain: TypedDataDomain,
		private readonly signFn: SignFn,
	) {
		this.baseUrl = baseUrl.replace(/\/+$/, "");
	}

	private async readAuth(): Promise<Hex> {
		if (this.cachedReadAuth) return this.cachedReadAuth;
		this.cachedReadAuth = await signReadAuth(this.signFn, this.domain);
		return this.cachedReadAuth;
	}

	async submit(proposal: SignedProposal): Promise<number> {
		const response = await fetch(`${this.baseUrl}/proposals`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				orderUid: proposal.orderUid,
				sellAmount: proposal.sellAmount.toString(),
				minBuyAmount: proposal.minBuyAmount.toString(),
				quoteBuyAmount: proposal.quoteBuyAmount.toString(),
				interactions: proposal.interactions.map((interaction) => ({
					target: interaction.target,
					value: interaction.value.toString(),
					callData: interaction.callData,
				})),
				validUntil: proposal.validUntil.toString(),
				nonce: proposal.nonce.toString(),
				signature: proposal.signature,
			}),
		});
		if (response.status === 429) throw rateLimitError(response);
		if (!response.ok) {
			const error = await response.json().catch(() => ({ description: "unknown error" }));
			throw new Error(
				`submit ${response.status}: ${(error as { description?: string }).description ?? "unknown"}`,
			);
		}
		return ((await response.json()) as { id: number }).id;
	}

	async proposal(id: number): Promise<ProposalView> {
		const response = await fetch(`${this.baseUrl}/proposal/${id}`, {
			headers: { "X-Signature": await this.readAuth() },
		});
		if (response.status === 429) throw rateLimitError(response);
		if (!response.ok) throw new Error(`proposal ${response.status}`);
		return (await response.json()) as ProposalView;
	}

	async proposals(): Promise<ProposalMetadata[]> {
		const response = await fetch(`${this.baseUrl}/proposals/by-sub-solver`, {
			headers: { "X-Signature": await this.readAuth() },
		});
		if (response.status === 429) throw rateLimitError(response);
		if (!response.ok) throw new Error(`list proposals ${response.status}`);
		const body = (await response.json()) as {
			proposals: Array<{ id: number; orderUid: Hex; validUntil: string; status: string }>;
		};
		return body.proposals.map((proposal) => ({
			id: proposal.id,
			orderUid: proposal.orderUid,
			validUntil: BigInt(proposal.validUntil),
			status: proposal.status,
		}));
	}

	async cancel(id: number): Promise<void> {
		const signature = await signCancellation(this.signFn, this.domain, BigInt(id));
		const response = await fetch(`${this.baseUrl}/proposal/${id}`, {
			method: "DELETE",
			headers: { "X-Signature": signature },
		});
		if (response.status === 429) throw rateLimitError(response);
		if (!response.ok && response.status !== 204) throw new Error(`cancel ${response.status}`);
	}

	isTerminal(status: string): boolean {
		return isTerminalStatus(status as Parameters<typeof isTerminalStatus>[0]);
	}
}
