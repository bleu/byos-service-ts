export function parseDebitOperationId(args: string[]): number {
	if (args.length !== 1)
		throw new Error("Usage: pnpm --filter @byos/byos debit:resume -- <operation-id>");
	const id = Number(args[0]);
	if (!Number.isSafeInteger(id) || id <= 0)
		throw new Error("operation-id must be a positive integer");
	return id;
}
