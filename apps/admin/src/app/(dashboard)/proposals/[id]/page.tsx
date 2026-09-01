import Link from "next/link";
import { notFound } from "next/navigation";
import { getProposal } from "@/lib/api";

function isoZ(dateStr: string) {
  return new Date(dateStr).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export default async function ProposalDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: idStr } = await params;
  const id = Number(idStr);

  if (!Number.isSafeInteger(id) || id <= 0) notFound();

  let data: any;
  try {
    data = await getProposal(id);
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
          <Field label="Subsolver">
            <ExternalLink href={proposal.subSolverUrl} mono>{proposal.subSolver}</ExternalLink>
          </Field>
          <Field label="Status">
            <span>{proposal.status}</span>
          </Field>
          <Field label="Order UID">
            <ExternalLink href={proposal.orderUidUrl} mono>{proposal.orderUid}</ExternalLink>
          </Field>
          <Field label="Rejection reason">
            <span className="font-mono">{proposal.rejectionReason ?? "—"}</span>
          </Field>
          <Field label="Sell token">
            <span className="font-mono text-xs break-all">{proposal.sellToken}</span>
          </Field>
          <Field label="Buy token">
            <span className="font-mono text-xs break-all">{proposal.buyToken}</span>
          </Field>
          <Field label="Sell amount">
            <span className="font-mono text-xs">{proposal.sellAmount}</span>
          </Field>
          <Field label="Min buy amount">
            <span className="font-mono text-xs">{proposal.minBuyAmount}</span>
          </Field>
          <Field label="Settlement tx">
            {proposal.settlementTxHash ? (
              <div className="flex flex-wrap gap-2 font-mono text-xs break-all">
                <ExternalLink href={proposal.explorerUrl}>{proposal.settlementTxHash}</ExternalLink>
                {proposal.tenderlyUrl && (
                  <a href={proposal.tenderlyUrl} target="_blank" rel="noopener noreferrer" className="text-gray-400 hover:text-gray-700 underline non-mono text-xs">
                    Tenderly
                  </a>
                )}
              </div>
            ) : (
              <span className="text-gray-400">—</span>
            )}
          </Field>
          <Field label="Penalty tx">
            {proposal.penaltyTxHash ? (
              <div className="flex flex-wrap gap-2 font-mono text-xs break-all">
                <ExternalLink href={proposal.penaltyTxLinks?.explorerUrl}>{proposal.penaltyTxHash}</ExternalLink>
                {proposal.penaltyTxLinks?.tenderlyUrl && (
                  <a href={proposal.penaltyTxLinks.tenderlyUrl} target="_blank" rel="noopener noreferrer" className="text-gray-400 hover:text-gray-700 underline non-mono text-xs">
                    Tenderly
                  </a>
                )}
              </div>
            ) : (
              <span className="text-gray-400">—</span>
            )}
          </Field>
          <Field label="Created">
            <span className="font-mono text-xs">{isoZ(proposal.createdAt)}</span>
          </Field>
          <Field label="Last updated">
            <span className="font-mono text-xs">{isoZ(proposal.statusChangedAt)}</span>
          </Field>
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
                  <span className="text-xs text-gray-400 font-mono">
                    {isoZ(event.occurredAt)}
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-gray-500 text-xs mb-0.5">{label}</dt>
      <dd className="text-sm break-all">{children}</dd>
    </div>
  );
}

function ExternalLink({
  href,
  children,
  mono = true,
}: {
  href?: string | null;
  children: React.ReactNode;
  mono?: boolean;
}) {
  const cls = `${mono ? "font-mono text-xs" : "text-xs"} break-all`;
  if (!href) return <span className={cls}>{children}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={`${cls} text-blue-600 hover:underline`}>
      {children}
    </a>
  );
}
