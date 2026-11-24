import { setMaxListeners } from "node:events";

/** Local lifecycle for one auction push; no proposal wire-format changes. */
export interface AuctionWork {
	auctionId: string;
	deadlineMs: number;
	receivedAtMs: number;
	deadlineBufferMs: number;
	signal: AbortSignal;
}

export function canQuote(work?: AuctionWork): boolean {
	return (
		!work || (!work.signal.aborted && Date.now() < work.deadlineMs - work.deadlineBufferMs - 100)
	);
}

export function canSubmit(work?: AuctionWork): boolean {
	return !work || (!work.signal.aborted && Date.now() < work.deadlineMs - work.deadlineBufferMs);
}

/** Bound each network request, including reading its response body. */
export function requestSignal(
	work?: AuctionWork,
	phase: "quote" | "submit" = "quote",
	timeoutMs = 5000,
): AbortSignal {
	const cutoff = work
		? work.deadlineMs - (phase === "quote" ? work.deadlineBufferMs + 100 : 200)
		: Infinity;
	const remaining = Math.min(timeoutMs, cutoff - Date.now());
	if (remaining <= 0) throw new DOMException("Auction deadline reached", "TimeoutError");
	const timeout = AbortSignal.timeout(Math.max(1, Math.floor(remaining)));
	const signal = work ? AbortSignal.any([work.signal, timeout]) : timeout;
	signal.throwIfAborted();
	return signal;
}

/** Also releases callers when an injected SDK or test double ignores abort. */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason);
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		signal.addEventListener("abort", abort, { once: true });
	});
}

export function createAuctionWork(params: Omit<AuctionWork, "signal">): {
	work: AuctionWork;
	abort: () => void;
	dispose: () => void;
} {
	const controller = new AbortController();
	setMaxListeners(0, controller.signal);
	const timer = setTimeout(
		() => controller.abort(new DOMException("Auction deadline reached", "TimeoutError")),
		Math.max(0, Math.min(30_000, params.deadlineMs - Date.now() - 200)),
	);
	timer.unref();
	return {
		work: { ...params, signal: controller.signal } satisfies AuctionWork,
		abort: () => controller.abort(new DOMException("Auction superseded", "AbortError")),
		dispose: () => clearTimeout(timer),
	};
}
