import "dotenv/config";
import { parseConfig } from "./config.js";
import { createDb } from "./db/index.js";
import { parseDebitOperationId } from "./infra/cli/resume-debit.js";
import { resumeDebitOperation } from "./infra/storage.js";

async function main(): Promise<void> {
	const id = parseDebitOperationId(process.argv.slice(2));
	const config = parseConfig();
	const { db, client } = createDb(config.DATABASE_URL);
	try {
		if (!(await resumeDebitOperation(db, id))) {
			throw new Error(`Debit operation ${id} is not parked in needs_reconciliation`);
		}
		console.info(`Debit operation ${id} resumed`);
	} finally {
		await client.end();
	}
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
