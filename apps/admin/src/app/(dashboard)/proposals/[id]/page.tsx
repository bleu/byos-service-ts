import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import {
	blockExplorerAddressUrl,
	cowExplorerOrderUrl,
	txLinks,
} from "@/lib/formatters";
import { getProposalDetail } from "@/lib/queries";

function isoZ(date: Date | string) {
  return new Date(date).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export default async function ProposalDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: idStr } = await params;
  const id = Number(idStr);

  if (!Number.isSafeInteger(id) || id <= 0) notFound();

  const detail = await getProposalDetail(db, id);
  if (!detail) notFound();

  const { auditTrail } = detail;
  const raw = detail.proposal;
  const proposal = {
    ...raw,
    subSolverUrl: blockExplorerAddressUrl(raw.subSolver),
    orderUidUrl: cowExplorerOrderUrl(raw.orderUid),
    ...txLinks(raw.settlementTxHash),
    penaltyTxLinks: txLinks(raw.penaltyTxHash),
  };

  return (
    <div className="max-w-3xl space-y-5">
      <div className="flex items-center gap-3">
        <Link href="/proposals" className="text-[12px] text-muted hover:text-ink hover:underline">
          ← Proposals
        </Link>
        <span className="text-dim">/</span>
        <h1 className="text-[13px] font-semibold text-ink font-mono">#{proposal.id}</h1>
      </div>

      {/* Details */}
      <div className="bg-surface border border-line rounded">
        <div className="px-5 py-3 border-b border-line">
          <span className="text-[10px] uppercase tracking-widest text-dim font-medium">Details</span>
        </div>
        <dl className="grid grid-cols-2 divide-x-0 p-5 gap-x-8 gap-y-4">
          <Field label="Subsolver">
            <ExternalLink href={proposal.subSolverUrl}>{proposal.subSolver}</ExternalLink>
          </Field>
          <Field label="Status">
            <span className="font-mono text-[12px] text-ink">{proposal.status}</span>
          </Field>
          <Field label="Order UID">
            <ExternalLink href={proposal.orderUidUrl}>{proposal.orderUid}</ExternalLink>
          </Field>
          <Field label="Rejection reason">
            <span className="font-mono text-[12px] text-muted">{proposal.rejectionReason ?? <span className="text-dim">—</span>}</span>
          </Field>
          <Field label="Sell token">
            <span className="font-mono text-[12px] text-muted break-all">{proposal.sellToken ?? <span className="text-dim">—</span>}</span>
          </Field>
          <Field label="Buy token">
            <span className="font-mono text-[12px] text-muted break-all">{proposal.buyToken ?? <span className="text-dim">—</span>}</span>
          </Field>
          <Field label="Sell amount">
            <span className="font-mono text-[12px] text-muted">{proposal.sellAmount}</span>
          </Field>
          <Field label="Min buy amount">
            <span className="font-mono text-[12px] text-muted">{proposal.minBuyAmount}</span>
          </Field>
          <Field label="Settlement tx">
            {proposal.settlementTxHash ? (
              <div className="space-y-1">
                <ExternalLink href={proposal.explorerUrl}>{proposal.settlementTxHash}</ExternalLink>
                {proposal.tenderlyUrl && (
                  <div>
                    <a href={proposal.tenderlyUrl} target="_blank" rel="noopener noreferrer" className="text-[11px] text-dim hover:text-muted underline">
                      Tenderly
                    </a>
                  </div>
                )}
              </div>
            ) : (
              <span className="text-dim font-mono text-[12px]">—</span>
            )}
          </Field>
          <Field label="Penalty tx">
            {proposal.penaltyTxHash ? (
              <div className="space-y-1">
                <ExternalLink href={proposal.penaltyTxLinks?.explorerUrl}>{proposal.penaltyTxHash}</ExternalLink>
                {proposal.penaltyTxLinks?.tenderlyUrl && (
                  <div>
                    <a href={proposal.penaltyTxLinks.tenderlyUrl} target="_blank" rel="noopener noreferrer" className="text-[11px] text-dim hover:text-muted underline">
                      Tenderly
                    </a>
                  </div>
                )}
              </div>
            ) : (
              <span className="text-dim font-mono text-[12px]">—</span>
            )}
          </Field>
          <Field label="Created">
            <span className="font-mono text-[12px] text-muted">{isoZ(proposal.createdAt)}</span>
          </Field>
          <Field label="Last updated">
            <span className="font-mono text-[12px] text-muted">{isoZ(proposal.statusChangedAt)}</span>
          </Field>
        </dl>
      </div>

      {/* Audit trail */}
      <div className="bg-surface border border-line rounded">
        <div className="px-5 py-3 border-b border-line">
          <span className="text-[10px] uppercase tracking-widest text-dim font-medium">Audit trail</span>
        </div>
        <div className="p-4 space-y-2">
          {auditTrail.map((event) => (
            <div key={event.id} className="border border-line rounded p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[11px] font-medium text-accent bg-accent-tint px-1.5 py-0.5 rounded-sm">
                  {event.eventType}
                </span>
                <span className="font-mono text-[11px] text-dim">
                  {isoZ(event.occurredAt)}
                </span>
              </div>
              {(() => {
                const p = event.payload as Record<string, unknown> | null;
                return p && Object.keys(p).length > 0 ? (
                  <pre className="font-mono text-[11px] text-muted bg-base rounded p-3 overflow-x-auto leading-relaxed">
                    {JSON.stringify(p, null, 2)}
                  </pre>
                ) : null;
              })()}
            </div>
          ))}
          {auditTrail.length === 0 && (
            <p className="text-[12px] text-dim py-4 text-center">No audit events recorded.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-widest text-dim font-medium mb-1">{label}</dt>
      <dd className="break-all">{children}</dd>
    </div>
  );
}

function ExternalLink({ href, children }: { href?: string | null; children: React.ReactNode }) {
  const cls = "font-mono text-[12px] break-all";
  if (!href) return <span className={`${cls} text-muted`}>{children}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={`${cls} text-accent hover:underline`}>
      {children}
    </a>
  );
}
