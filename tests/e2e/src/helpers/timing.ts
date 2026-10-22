/** Durations use a monotonic clock; elapsedMs includes all previous steps. */
export function createTimingLog(scope: string) {
	const start = performance.now();
	let previous = start;
	console.log(`[e2e-timing] ${scope} start`);
	return (step: string) => {
		const now = performance.now();
		console.log(
			`[e2e-timing] ${JSON.stringify({
				scope,
				step,
				durationMs: Math.round(now - previous),
				elapsedMs: Math.round(now - start),
			})}`,
		);
		previous = now;
	};
}
