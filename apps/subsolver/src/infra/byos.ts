import { isTerminalStatus, signCancellation, signReadAuth } from "@byos/common";
import type { SignedProposal } from "@byos/subsolver-core";
import type { Hex, TypedDataDomain } from "viem";

// biome-ignore lint/suspicious/noExplicitAny: viem overloaded signTypedData types
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

/** Signals an explicit API rate limit so the polling loop can honour it. */
export class ByosRateLimitError extends Error {
	constructor(readonly retryAfterMs: number) {
		super("BYOS request budget exhausted");
	}
}

function rateLimitError(response: Response): ByosRateLimitError {
	const seconds = Number(response.headers.get("Retry-After") ?? "1");
	return new ByosRateLimitError(Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 1000);
}

export class ByosClient {
	private baseUrl: string;
	private domain: TypedDataDomain;
	private signFn: SignFn;
	private cachedReadAuth: Hex | null = null;

	constructor(baseUrl: string, domain: TypedDataDomain, signFn: SignFn) {
		this.baseUrl = baseUrl.replace(/\/+$/, "");
		this.domain = domain;
		this.signFn = signFn;
	}

	private async readAuth(): Promise<Hex> {
		if (this.cachedReadAuth) return this.cachedReadAuth;
		this.cachedReadAuth = await signReadAuth(this.signFn, this.domain);
		return this.cachedReadAuth;
	}

	/** Submits a signed proposal to the BYOS service. Returns the server-assigned id. */
	async submit(proposal: SignedProposal): Promise<number> {
		const body = {
			orderUid: proposal.orderUid,
			sellAmount: proposal.sellAmount.toString(),
			minBuyAmount: proposal.minBuyAmount.toString(),
			quoteBuyAmount: proposal.quoteBuyAmount.toString(),
			interactions: proposal.interactions.map((i) => ({
				target: i.target,
				value: i.value.toString(),
				callData: i.callData,
			})),
			validUntil: proposal.validUntil.toString(),
			nonce: proposal.nonce.toString(),
			signature: proposal.signature,
		};

		const response = await fetch(`${this.baseUrl}/proposals`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		if (response.status === 429) throw rateLimitError(response);

		if (!response.ok) {
			const err = await response.json().catch(() => ({ description: "unknown error" }));
			throw new Error(
				`submit ${response.status}: ${(err as { description?: string }).description ?? "unknown"}`,
			);
		}

		const data = (await response.json()) as { id: number };
		return data.id;
	}

	/** Polls the verdict of a proposal. */
	async proposal(id: number): Promise<ProposalView> {
		const sig = await this.readAuth();
		const response = await fetch(`${this.baseUrl}/proposal/${id}`, {
			headers: { "X-Signature": sig },
		});
		if (response.status === 429) throw rateLimitError(response);

		if (!response.ok) {
			throw new Error(`proposal ${response.status}`);
		}

		return (await response.json()) as ProposalView;
	}

	/** Bulk owner-scoped snapshot used to recover proposal state after restart. */
	async proposals(): Promise<ProposalMetadata[]> {
		const sig = await this.readAuth();
		const response = await fetch(`${this.baseUrl}/proposals/by-sub-solver`, {
			headers: { "X-Signature": sig },
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

	/** Cancels a proposal. */
	async cancel(id: number): Promise<void> {
		const sig = await signCancellation(this.signFn, this.domain, BigInt(id));
		const response = await fetch(`${this.baseUrl}/proposal/${id}`, {
			method: "DELETE",
			headers: { "X-Signature": sig },
		});

		if (!response.ok && response.status !== 204) {
			throw new Error(`cancel ${response.status}`);
		}
	}

	/** Checks if a status is terminal (sub-solver should resubmit). */
	isTerminal(status: string): boolean {
		return isTerminalStatus(status as Parameters<typeof isTerminalStatus>[0]);
	}
}
