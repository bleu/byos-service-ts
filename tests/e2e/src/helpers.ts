import type { AuditEvent } from "@byos/byos/src/domain/audit.js";
import type { BalanceCache } from "@byos/byos/src/domain/balance-cache.js";
import type { Proposal } from "@byos/byos/src/domain/proposal.js";
import type { RateLimiter } from "@byos/byos/src/domain/rate-limit.js";
import {
	createInternalApp,
	createPublicApp,
	DEFAULT_RATE_LIMITS,
} from "@byos/byos/src/infra/api/index.js";
import * as store from "@byos/byos/src/infra/storage.js";
import { createTestDb, type TestContext } from "@byos/byos/test/setup.js";
import type { ContractInteraction } from "@byos/common";
import {
	byosDomain,
	computeInteractionsHash,
	signCancellation,
	signProposal,
	signReadAuth,
} from "@byos/common";
import type { Hono } from "hono";
import type { Address, Hex } from "viem";
import { createWalletClient, http, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

// --- Fixtures ---

export const CHAIN_ID = 1;
export const TRAMPOLINE_FACTORY: Address = "0x00000000000000000000000000000000000000cc";
export const MAX_PROPOSAL_LIFETIME_SECS = 300;

export const DOMAIN = byosDomain(CHAIN_ID, TRAMPOLINE_FACTORY);

// Anvil default accounts
export const SIGNER_KEY =
	"0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
export const OTHER_SIGNER_KEY =
	"0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;

export const SIGNER_ACCOUNT = privateKeyToAccount(SIGNER_KEY);
export const OTHER_SIGNER_ACCOUNT = privateKeyToAccount(OTHER_SIGNER_KEY);

// biome-ignore lint/suspicious/noExplicitAny: viem overloaded signTypedData types
function makeSignFn(
	account: ReturnType<typeof privateKeyToAccount>,
): (params: any) => Promise<Hex> {
	const client = createWalletClient({ account, chain: foundry, transport: http() });
	// biome-ignore lint/suspicious/noExplicitAny: viem overloaded signTypedData types
	return (params: any) => client.signTypedData(params);
}

export const SIGN_FN = makeSignFn(SIGNER_ACCOUNT);
export const OTHER_SIGN_FN = makeSignFn(OTHER_SIGNER_ACCOUNT);

// --- Test App Factory ---

export interface TestApp {
	publicApp: Hono;
	internalApp: Hono;
	ctx: TestContext;
	gasPriceRef: { value: bigint };
	auditEvents: AuditEvent[];
}

/** Rate limiting is off unless a test asks for it: the default `allowAll`
 * and `unknownBalances` stubs keep the other e2e files free of Redis, and
 * several of them fire more requests from one signer than a live limiter
 * would allow. */
export interface TestAppOverrides {
	rateLimiter?: RateLimiter;
	balances?: BalanceCache;
	/** Per-IP allowance. Defaults to the loose production backstop. */
	ipLimit?: number;
	/** Escrow floor for the synchronous gate. Defaults to 0.01 ETH. */
	floorWei?: bigint;
}

export async function createTestApp(overrides: TestAppOverrides = {}): Promise<TestApp> {
	const ctx = await createTestDb();
	const gasPriceRef = { value: 10_000_000_000n }; // 10 gwei default
	const auditEvents: AuditEvent[] = [];

	const appCtx = {
		db: ctx.db,
		chainId: CHAIN_ID,
		trampolineFactory: TRAMPOLINE_FACTORY,
		maxProposalLifetimeSecs: MAX_PROPOSAL_LIFETIME_SECS,
		gasPriceRef,
		onAuditEvent: (e: AuditEvent) => auditEvents.push(e),
		rateLimiter: overrides.rateLimiter,
		balances: overrides.balances,
		rateLimits: {
			...DEFAULT_RATE_LIMITS,
			ipPerWindow: overrides.ipLimit ?? DEFAULT_RATE_LIMITS.ipPerWindow,
			floorWei: overrides.floorWei ?? 10n ** 16n,
		},
	};

	const publicApp = createPublicApp(appCtx);
	const internalApp = createInternalApp(appCtx);

	return { publicApp, internalApp, ctx, gasPriceRef, auditEvents };
}

// --- Proposal Helpers ---

export interface ProposalOverrides {
	orderUid?: Hex;
	sellAmount?: bigint;
	buyAmount?: bigint;
	validUntil?: bigint;
	nonce?: bigint;
	interactions?: ContractInteraction[];
}

export async function signAndSubmitProposal(app: Hono, overrides?: ProposalOverrides) {
	const orderUid = overrides?.orderUid ?? (`0x${"ab".repeat(56)}` as Hex);
	const sellAmount = overrides?.sellAmount ?? 1_000_000n;
	const buyAmount = overrides?.buyAmount ?? 990_000n;
	const now = BigInt(Math.floor(Date.now() / 1000));
	const validUntil = overrides?.validUntil ?? now + 240n;
	const nonce = overrides?.nonce ?? 1n;
	const interactions: ContractInteraction[] = overrides?.interactions ?? [
		{
			target: "0x00000000000000000000000000000000000000dd" as Address,
			value: 0n,
			callData: "0xdead" as Hex,
		},
	];

	const orderUidHash = keccak256(orderUid);
	const _interactionsHash = computeInteractionsHash(interactions);

	const proposal = { orderUidHash, sellAmount, buyAmount, validUntil, nonce };
	const signature = await signProposal(SIGN_FN, DOMAIN, proposal, interactions);

	const body = {
		orderUid,
		sellAmount: sellAmount.toString(),
		buyAmount: buyAmount.toString(),
		interactions: interactions.map((i) => ({
			target: i.target,
			value: i.value.toString(),
			callData: i.callData,
		})),
		validUntil: validUntil.toString(),
		nonce: nonce.toString(),
		signature,
	};

	const response = await app.request("/proposals", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});

	return { response, body, orderUid };
}

// --- Direct-insert seeding (the Rust tests' test_proposal fixture) ---

/** Inserts a proposal directly into the store, bypassing the HTTP layer, so
 * tests can seed any status/simulation state. Defaults mirror the Rust
 * test_proposal fixture: sell 1_000_000, buy 990_000, far-future expiry. */
export async function seedProposal(
	db: TestContext["db"],
	overrides: Partial<Omit<Proposal, "id">> & { orderUid: string },
): Promise<number> {
	const orderUid = overrides.orderUid.toLowerCase() as Hex;
	const proposal: Omit<Proposal, "id"> = {
		subSolver: "0x0101010101010101010101010101010101010101" as Address,
		orderUidHash: keccak256(orderUid),
		sellAmount: 1_000_000n,
		buyAmount: 990_000n,
		sellToken: "0x0000000000000000000000000000000000000000" as Address,
		buyToken: "0x0000000000000000000000000000000000000000" as Address,
		interactions: [],
		interactionsHash: `0x${"00".repeat(32)}` as Hex,
		validUntil: 2n ** 40n,
		nonce: 1n,
		signature: "0x" as Hex,
		status: "active",
		rejectionReason: null,
		gasUsed: null,
		trampoline: null,
		settlementTxHash: null,
		penaltyTxHash: null,
		...overrides,
		orderUid,
	};
	const { id } = await store.insert(db, proposal);
	return id;
}

// --- Auth Helpers ---

export async function readAuthHeader(): Promise<Hex> {
	return signReadAuth(SIGN_FN, DOMAIN);
}

export async function otherReadAuthHeader(): Promise<Hex> {
	return signReadAuth(OTHER_SIGN_FN, DOMAIN);
}

export async function cancelSignatureHeader(proposalId: number): Promise<Hex> {
	return signCancellation(SIGN_FN, DOMAIN, BigInt(proposalId));
}
