import type { Solution } from "./types.js";

/** One selected proposal per order. Selection has already applied auction gates. */
export interface SelectedSolution {
	subSolver: string;
	proposalId: number;
	buyTokenRefPrice: string;
	solution: Solution;
}

function gcd(a: bigint, b: bigint): bigint {
	while (b !== 0n) [a, b] = [b, a % b];
	return a;
}

/** Scale both price vectors exactly; incompatible ratios remain separate bids. */
function mergePrices(
	left: Record<string, string>,
	right: Record<string, string>,
): Record<string, string> | null {
	const a = Object.fromEntries(
		Object.entries(left).map(([token, price]) => [token.toLowerCase(), BigInt(price)]),
	);
	const b = Object.fromEntries(
		Object.entries(right).map(([token, price]) => [token.toLowerCase(), BigInt(price)]),
	);
	const shared = Object.keys(a).find((token) => b[token] !== undefined);
	let leftScale = 1n;
	let rightScale = 1n;
	if (shared) {
		const leftPrice = a[shared];
		const rightPrice = b[shared];
		if (leftPrice === undefined || rightPrice === undefined || leftPrice <= 0n || rightPrice <= 0n)
			return null;
		const divisor = gcd(leftPrice, rightPrice);
		leftScale = rightPrice / divisor;
		rightScale = leftPrice / divisor;
	}
	const prices: Record<string, bigint> = {};
	for (const [token, price] of Object.entries(a)) prices[token] = price * leftScale;
	for (const [token, price] of Object.entries(b)) {
		const scaled = price * rightScale;
		if (prices[token] !== undefined && prices[token] !== scaled) return null;
		prices[token] = scaled;
	}
	const divisor = Object.values(prices).reduce(gcd);
	const normalized = Object.entries(prices).map(
		([token, price]) => [token, price / divisor] as const,
	);
	if (normalized.some(([, price]) => price <= 0n || price >= 2n ** 256n)) return null;
	return Object.fromEntries(normalized.map(([token, price]) => [token, price.toString()]));
}

export function batchSolutions(
	selected: SelectedSolution[],
): { solution: Solution; members: SelectedSolution[] }[] {
	const batches: { solution: Solution; members: SelectedSolution[] }[] = [];
	for (const candidate of selected) {
		let joined = false;
		for (const batch of batches) {
			if (batch.members[0]?.subSolver.toLowerCase() !== candidate.subSolver.toLowerCase()) continue;
			const existing = new Set(batch.solution.trades.map((trade) => trade.order.toLowerCase()));
			if (candidate.solution.trades.some((trade) => existing.has(trade.order.toLowerCase())))
				continue;
			const prices = mergePrices(batch.solution.prices, candidate.solution.prices);
			if (!prices) continue;
			batch.solution = {
				id: batch.solution.id,
				prices,
				trades: [...batch.solution.trades, ...candidate.solution.trades],
				pre_interactions: [
					...batch.solution.pre_interactions,
					...candidate.solution.pre_interactions,
				],
				interactions: [...batch.solution.interactions, ...candidate.solution.interactions],
				post_interactions: [
					...batch.solution.post_interactions,
					...candidate.solution.post_interactions,
				],
				gas: batch.solution.gas + candidate.solution.gas,
			};
			batch.members.push(candidate);
			joined = true;
			break;
		}
		if (!joined)
			batches.push({
				solution: { ...candidate.solution, id: batches.length + 1 },
				members: [candidate],
			});
	}
	return batches;
}
