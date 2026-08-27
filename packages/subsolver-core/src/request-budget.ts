/** Sliding-window request budget that reserves capacity for state reads. */
export class RequestBudget {
	private timestamps: number[] = [];

	constructor(
		private readonly limit = 100,
		private readonly reserve = 10,
		private readonly now: () => number = () => Date.now(),
	) {}

	canSubmit(): boolean {
		this.prune();
		return this.timestamps.length < this.limit - this.reserve;
	}

	canRead(): boolean {
		this.prune();
		return this.timestamps.length < this.limit;
	}

	consumeSubmission(): boolean {
		if (!this.canSubmit()) return false;
		this.timestamps.push(this.now());
		return true;
	}

	consumeRead(): boolean {
		if (!this.canRead()) return false;
		this.timestamps.push(this.now());
		return true;
	}

	private prune(): void {
		const cutoff = this.now() - 60_000;
		this.timestamps = this.timestamps.filter((timestamp) => timestamp > cutoff);
	}
}
