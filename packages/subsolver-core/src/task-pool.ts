/** One pool per sub-solver bounds submissions across all orders and cycles. */
export function createTaskPool(concurrency: number) {
	if (!Number.isInteger(concurrency) || concurrency < 1)
		throw new Error("Submission concurrency must be positive");
	let active = 0;
	const waiting: (() => void)[] = [];
	return {
		async run<T>(task: () => Promise<T>): Promise<T> {
			await new Promise<void>((resolve) => {
				const start = () => {
					active++;
					resolve();
				};
				if (active < concurrency) start();
				else waiting.push(start);
			});
			try {
				return await task();
			} finally {
				active--;
				waiting.shift()?.();
			}
		},
	};
}
