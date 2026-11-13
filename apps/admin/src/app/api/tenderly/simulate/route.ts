import { db } from "@/lib/db";
import { getProposalDetail } from "@/lib/queries";
import {
	createTenderlySimulation,
	isTenderlyCredentials,
	type SimulationParams,
} from "@/lib/tenderly";

export async function POST(request: Request) {
	// Credentials are forwarded only for this request; never persisted server-side.
	let sameOrigin = false;
	try {
		// Next may construct request.url with its internal hostname behind a proxy.
		sameOrigin = new URL(request.headers.get("origin") ?? "").host === request.headers.get("host");
	} catch {
		// A missing or malformed browser Origin is rejected.
	}
	if (!sameOrigin) {
		return Response.json({ error: "Invalid request origin." }, { status: 403 });
	}
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: "Invalid request body." }, { status: 400 });
	}
	if (
		!body ||
		typeof body !== "object" ||
		!("proposalId" in body) ||
		!Number.isSafeInteger(body.proposalId) ||
		Number(body.proposalId) <= 0 ||
		!("credentials" in body) ||
		!isTenderlyCredentials(body.credentials)
	) {
		return Response.json(
			{ error: "Provide a proposal ID and Tenderly account, project, and access key." },
			{ status: 400 },
		);
	}
	const detail = await getProposalDetail(db, Number(body.proposalId));
	if (!detail) return Response.json({ error: "Proposal not found." }, { status: 404 });
	const params = detail.proposal.simulationFailureParams as SimulationParams | null;
	if (!params)
		return Response.json(
			{ error: "This proposal has no saved simulation parameters." },
			{ status: 422 },
		);
	try {
		const url = await createTenderlySimulation(body.credentials, params);
		return Response.json({ url }, { headers: { "Cache-Control": "no-store" } });
	} catch (error) {
		const message =
			error instanceof Error && error.name === "TimeoutError"
				? "Tenderly timed out. Try again."
				: error instanceof TypeError
					? "Could not reach Tenderly. Try again."
					: error instanceof Error
						? error.message
						: "Could not create the Tenderly simulation.";
		return Response.json({ error: message }, { status: 502 });
	}
}
