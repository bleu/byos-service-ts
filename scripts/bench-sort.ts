const url = "https://solver-instances.s3.eu-central-1.amazonaws.com/prod/bnb/auction/26542932.json";
const res = await fetch(url);
const snapshot = (await res.json()) as {
	tokens: Record<string, { referencePrice?: string }>;
	orders: { buyToken: string; sellToken: string; buyAmount: string; sellAmount: string }[];
};

const { tokens, orders } = snapshot;

function nativeValue(amount: string, price: string): bigint {
	return (BigInt(amount) * BigInt(price)) / BigInt(1e18);
}

function surplus(order: {
	buyToken: string;
	sellToken: string;
	buyAmount: string;
	sellAmount: string;
}): bigint | null {
	const b = tokens[order.buyToken]?.referencePrice;
	const s = tokens[order.sellToken]?.referencePrice;
	if (!b || !s) return null;
	return nativeValue(order.buyAmount, b) - nativeValue(order.sellAmount, s);
}

const scored = orders
	.map((o) => ({ o, s: surplus(o) }))
	.filter((x): x is { o: (typeof orders)[0]; s: bigint } => x.s !== null);

const RUNS = 1000;
const start = performance.now();
for (let i = 0; i < RUNS; i++) {
	const copy = scored.slice();
	copy.sort((a, b) => (a.s > b.s ? -1 : a.s < b.s ? 1 : 0));
}
const elapsed = performance.now() - start;

console.log(`Orders scored: ${scored.length}`);
console.log(`Runs:          ${RUNS}`);
console.log(`Total:         ${elapsed.toFixed(2)}ms`);
console.log(`Per sort:      ${(elapsed / RUNS).toFixed(3)}ms`);
