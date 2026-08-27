import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { getProposal } from "@/lib/api";

export default async function ProposalDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  const idToken = (session as any)?.idToken as string;
  const { id: idStr } = await params;
  const id = Number(idStr);

  if (!Number.isSafeInteger(id) || id <= 0) notFound();

  let data: any;
  try {
    data = await getProposal(idToken, id);
  } catch {
    notFound();
  }

  const { proposal, auditTrail } = data;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/proposals" className="text-sm text-blue-600 hover:underline">
          ← Proposals
        </Link>
        <h1 className="text-xl font-bold">Proposal #{proposal.id}</h1>
      </div>

      {/* Proposal fields */}
      <div className="bg-white rounded-lg border border-gray-200 p-5">
        <h2 className="font-semibold mb-4">Details</h2>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
          <Field label="Subsolver" value={proposal.subSolver} mono />
          <Field label="Status" value={proposal.status} />
          <Field label="Order UID" value={proposal.orderUid} mono />
          <Field label="Rejection reason" value={proposal.rejectionReason ?? "—"} />
          <Field label="Sell token" value={proposal.sellToken} mono />
          <Field label="Buy token" value={proposal.buyToken} mono />
          <Field label="Sell amount" value={proposal.sellAmount} mono />
          <Field label="Min buy amount" value={proposal.minBuyAmount} mono />
          <Field label="Settlement tx" value={proposal.settlementTxHash ?? "—"} mono />
          <Field label="Penalty tx" value={proposal.penaltyTxHash ?? "—"} mono />
          <Field label="Created" value={new Date(proposal.createdAt).toLocaleString()} />
          <Field label="Last updated" value={new Date(proposal.statusChangedAt).toLocaleString()} />
        </dl>
      </div>

      {/* Audit trail */}
      <div className="bg-white rounded-lg border border-gray-200 p-5">
        <h2 className="font-semibold mb-4">Audit trail</h2>
        <div className="space-y-3">
          {auditTrail.map(
            (event: {
              id: number;
              eventType: string;
              payload: unknown;
              occurredAt: string;
            }) => (
              <div key={event.id} className="border border-gray-100 rounded p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-mono text-xs font-semibold text-blue-700 bg-blue-50 px-2 py-0.5 rounded">
                    {event.eventType}
                  </span>
                  <span className="text-xs text-gray-400">
                    {new Date(event.occurredAt).toLocaleString()}
                  </span>
                </div>
                {(() => {
                  const p = event.payload as Record<string, unknown> | null;
                  return p && Object.keys(p).length > 0 ? (
                    <pre className="text-xs text-gray-600 bg-gray-50 rounded p-2 overflow-x-auto mt-1">
                      {JSON.stringify(p, null, 2)}
                    </pre>
                  ) : null;
                })()}
              </div>
            ),
          )}
          {auditTrail.length === 0 && (
            <p className="text-sm text-gray-400">No audit events recorded.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-gray-500 text-xs mb-0.5">{label}</dt>
      <dd className={`text-sm break-all ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  );
}
