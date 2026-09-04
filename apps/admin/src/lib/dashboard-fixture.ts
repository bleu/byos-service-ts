import type { Sql } from "postgres";

const subSolvers = [
	"0x1111111111111111111111111111111111111111",
	"0x2222222222222222222222222222222222222222",
	"0x3333333333333333333333333333333333333333",
] as const;

type FixtureStatus =
	| "submitted"
	| "active"
	| "executing"
	| "rejected"
	| "simFailed"
	| "settled"
	| "settleFailed"
	| "penalized";

interface FixtureProposal {
	status: FixtureStatus;
	subSolver: (typeof subSolvers)[number];
	ageMinutes: number;
	rejectionReason?: string;
}

const fixtureProposals: FixtureProposal[] = [
	{ status: "submitted", subSolver: subSolvers[0], ageMinutes: 8 },
	{ status: "active", subSolver: subSolvers[0], ageMinutes: 16 },
	{ status: "executing", subSolver: subSolvers[1], ageMinutes: 24 },
	{
		status: "rejected",
		subSolver: subSolvers[1],
		ageMinutes: 32,
		rejectionReason: "invalidSignature",
	},
	{ status: "simFailed", subSolver: subSolvers[1], ageMinutes: 40 },
	{ status: "settled", subSolver: subSolvers[2], ageMinutes: 48 },
	{ status: "settleFailed", subSolver: subSolvers[2], ageMinutes: 56 },
	{ status: "penalized", subSolver: subSolvers[2], ageMinutes: 64 },
	// Historical rows keep the 7-day and 30-day range selectors useful.
	{ status: "settled", subSolver: subSolvers[0], ageMinutes: 2 * 24 * 60 },
	{
		status: "rejected",
		subSolver: subSolvers[1],
		ageMinutes: 8 * 24 * 60,
		rejectionReason: "expired",
	},
];

function hex(byte: number, bytes: number): string {
	return `0x${byte.toString(16).padStart(2, "0").repeat(bytes)}`;
}

function atMinutesBefore(now: Date, minutes: number): Date {
	return new Date(now.getTime() - minutes * 60_000);
}

/**
 * Inserts the small, time-relative dataset used to explore the local admin
 * dashboard. The caller owns database lifecycle; this function only inserts.
 */
export async function seedDashboardFixture(sql: Sql, now = new Date()): Promise<void> {
	for (const [index, fixture] of fixtureProposals.entries()) {
		const createdAt = atMinutesBefore(now, fixture.ageMinutes);
		const orderUid = hex(index + 1, 56);
		const orderUidHash = hex(index + 11, 32);
		const settlementTxHash =
			fixture.status === "settled" ||
			fixture.status === "settleFailed" ||
			fixture.status === "penalized"
				? hex(index + 31, 32)
				: null;
		const penaltyTxHash = fixture.status === "penalized" ? hex(index + 61, 32) : null;
		const [proposal] = await sql<[{ id: number }]>`
			INSERT INTO proposals (
				sub_solver, order_uid, order_uid_hash, sell_amount, min_buy_amount, quote_buy_amount,
				sell_token, buy_token, interactions, interactions_hash, valid_until, nonce, signature,
				status, rejection_reason, settlement_tx_hash, penalty_tx_hash, created_at, status_changed_at
			) VALUES (
				${fixture.subSolver}, ${orderUid}, ${orderUidHash}, '1000000000000000000', '990000000000000000', '1000000000000000000',
				${hex(161, 20)}, ${hex(178, 20)}, ${JSON.stringify([{ target: hex(193, 20), value: "0", callData: "0x" }])}, ${hex(201, 32)},
				${String(Math.floor(createdAt.getTime() / 1000) + 300)}, ${String(index + 1)}, ${hex(index + 91, 65)},
				${fixture.status}, ${fixture.rejectionReason ?? null}, ${settlementTxHash}, ${penaltyTxHash}, ${createdAt.toISOString()}, ${createdAt.toISOString()}
			) RETURNING id
		`;

		if (!proposal) throw new Error("dashboard fixture proposal was not inserted");

		await sql`
			INSERT INTO audit_events (proposal_id, event_type, sub_solver, order_uid, payload, occurred_at)
			VALUES (${proposal.id}, 'received', ${fixture.subSolver}, ${orderUid},
				${JSON.stringify({ id: proposal.id, fixture: true, status: fixture.status })}, ${createdAt.toISOString()})
		`;

		const addEvent = async (
			eventType: string,
			payload: Record<string, unknown>,
			minutesAfter = 1,
		) =>
			sql`
				INSERT INTO audit_events (proposal_id, event_type, sub_solver, order_uid, settlement_tx_hash, payload, occurred_at)
				VALUES (${proposal.id}, ${eventType}, ${fixture.subSolver}, ${orderUid}, ${settlementTxHash},
					${JSON.stringify(payload)}, ${new Date(createdAt.getTime() + minutesAfter * 60_000).toISOString()})
			`;

		if (fixture.status !== "submitted" && fixture.status !== "rejected") {
			await addEvent("validated", { from: "submitted", to: "active" });
		}
		if (fixture.status === "rejected") {
			await addEvent("rejected", {
				from: "submitted",
				to: "rejected",
				rejectionReason: fixture.rejectionReason,
			});
		}
		if (fixture.status === "simFailed")
			await addEvent("sim_failed", { from: "active", to: "simFailed" });
		if (["executing", "settled", "settleFailed", "penalized"].includes(fixture.status)) {
			await addEvent("settlement_started", { from: "active", to: "executing" }, 2);
		}
		if (["settled", "settleFailed", "penalized"].includes(fixture.status)) {
			await addEvent(
				"driver_notified",
				{ kind: fixture.status === "settled" ? "settled" : "reverted" },
				3,
			);
		}
		if (fixture.status === "settled") {
			await addEvent("settled", { from: "executing", to: "settled" }, 4);
			await sql`
				INSERT INTO buffer_entries (sub_solver, proposal_id, order_uid, delta, gap, buy_token, native_token_amount, cleared, created_at)
				VALUES (${fixture.subSolver}, ${proposal.id}, ${orderUid},
					'995000000000000000', '5000000000000000', ${hex(178, 20)},
					'3000000000000000', false, ${createdAt.toISOString()})
			`;
		}
		if (fixture.status === "settleFailed") {
			await addEvent("settle_failed", { from: "executing", to: "settleFailed" }, 4);
			await sql`
				INSERT INTO penalties (proposal_id, sub_solver, order_uid, penalty_tx_hash, created_at)
				VALUES (${proposal.id}, ${fixture.subSolver}, ${orderUid}, NULL, ${createdAt.toISOString()})
			`;
			await sql`
				INSERT INTO buffer_entries (sub_solver, proposal_id, order_uid, delta, gap, buy_token, native_token_amount, cleared, created_at)
				VALUES (${fixture.subSolver}, ${proposal.id}, ${orderUid},
					'980000000000000000', '20000000000000000', ${hex(178, 20)},
					'12000000000000000', false, ${createdAt.toISOString()})
			`;
		}
		if (fixture.status === "penalized") {
			await addEvent("settle_failed", { from: "executing", to: "settleFailed" }, 4);
			await addEvent(
				"penalized",
				{ amount: "2500000000000000", settlementTxHash, penaltyTxHash },
				5,
			);
			await sql`
				INSERT INTO penalties (proposal_id, sub_solver, order_uid, penalty_tx_hash, created_at)
				VALUES (${proposal.id}, ${fixture.subSolver}, ${orderUid}, ${penaltyTxHash}, ${createdAt.toISOString()})
			`;
			await sql`
				INSERT INTO buffer_entries (sub_solver, proposal_id, order_uid, delta, gap, buy_token, native_token_amount, cleared, created_at)
				VALUES (${fixture.subSolver}, ${proposal.id}, ${orderUid},
					'970000000000000000', '30000000000000000', ${hex(178, 20)},
					'18000000000000000', false, ${createdAt.toISOString()})
			`;
		}
	}

	const bufferProposal = await sql<[{ id: number; sub_solver: string; order_uid: string }]>`
		SELECT id, sub_solver, order_uid FROM proposals WHERE status = 'settled' LIMIT 1
	`;
	if (!bufferProposal[0]) throw new Error("dashboard fixture settled proposal was not found");
	await sql`
		INSERT INTO audit_events (proposal_id, event_type, sub_solver, order_uid, payload, occurred_at)
		VALUES (${bufferProposal[0].id}, 'buffer_debited', ${bufferProposal[0].sub_solver}, ${bufferProposal[0].order_uid},
			${JSON.stringify({ amount: "100000000000000", clearTxHash: hex(251, 32), entryCount: 1 })}, ${atMinutesBefore(now, 3).toISOString()})
	`;
}
