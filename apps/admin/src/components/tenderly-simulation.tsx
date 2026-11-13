"use client";

import { createContext, useContext, useRef, useState } from "react";
import { isTenderlyCredentials, TENDERLY_STORAGE_KEY, type TenderlyCredentials } from "@/lib/tenderly";

const EMPTY_CREDENTIALS: TenderlyCredentials = { account: "", project: "", accessKey: "" };
const TenderlyContext = createContext<{
  simulate: (id: number) => void;
  busy: boolean;
  configure: () => void;
} | null>(null);

function savedCredentials(): TenderlyCredentials | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(TENDERLY_STORAGE_KEY) ?? "null");
    return isTenderlyCredentials(value) ? value : null;
  } catch {
    return null;
  }
}

export function TenderlyProvider({ children }: { children: React.ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [credentials, setCredentials] = useState(EMPTY_CREDENTIALS);
  const [proposalId, setProposalId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [error, setError] = useState("");

  function configure() {
    setProposalId(null);
    setCredentials(savedCredentials() ?? EMPTY_CREDENTIALS);
    setError("");
    dialog.current?.showModal();
  }

  async function run(id: number, config: TenderlyCredentials) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    // Reserve a tab during the click/submit gesture so async fetch cannot trigger popup blocking.
    const tab = window.open("about:blank", "_blank");
    if (tab) {
      tab.opener = null;
      tab.document.title = "Creating Tenderly simulation…";
      tab.document.body.textContent = "Creating Tenderly simulation… This tab will open the result automatically.";
    }
    try {
      const response = await fetch("/api/tenderly/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proposalId: id, credentials: config }),
        signal: AbortSignal.timeout(65_000),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not create the simulation.");
      const url = new URL(result.url);
      if (url.origin !== "https://dashboard.tenderly.co") throw new Error("Invalid Tenderly result URL.");
      if (tab && !tab.closed) tab.location.replace(url.href);
      else window.location.assign(url.href);
      dialog.current?.close();
    } catch (cause) {
      tab?.close();
      setError(cause instanceof Error && cause.name === "TimeoutError"
        ? "Simulation request timed out. Try again."
        : cause instanceof Error ? cause.message : "Could not create the simulation.");
      setProposalId(id);
      setCredentials(config);
      if (!dialog.current?.open) dialog.current?.showModal();
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  function simulate(id: number) {
    if (running.current) return;
    const config = savedCredentials();
    setProposalId(id);
    setError("");
    if (config) void run(id, config);
    else {
      setCredentials(EMPTY_CREDENTIALS);
      dialog.current?.showModal();
    }
  }

  return (
    <TenderlyContext.Provider value={{ simulate, busy, configure }}>
      {children}
      <dialog ref={dialog} aria-labelledby="tenderly-title" onCancel={(event) => { if (busy) event.preventDefault(); }}
        className="fixed inset-0 m-auto w-full max-w-md rounded border border-line bg-surface p-6 text-ink shadow-xl backdrop:bg-black/30">
        <form onSubmit={(event) => {
          event.preventDefault();
          const config = {
            account: credentials.account.trim(), project: credentials.project.trim(), accessKey: credentials.accessKey.trim(),
          };
          if (!isTenderlyCredentials(config)) { setError("Enter a valid account, project slug, and access key."); return; }
          try { localStorage.setItem(TENDERLY_STORAGE_KEY, JSON.stringify(config)); }
          catch { setError("Browser storage is unavailable. Allow local storage to save your Tenderly settings."); return; }
          if (proposalId !== null) void run(proposalId, config);
          else dialog.current?.close();
        }} className="space-y-4">
          <h2 id="tenderly-title" className="text-[14px] font-semibold">Tenderly simulation</h2>
          <p className="text-[12px] text-muted">Enter the account and project slugs from your Tenderly dashboard URL. Settings are saved in this browser, including your access key.</p>
          <p className="text-[11px] text-dim">dashboard.tenderly.co/<strong>account</strong>/<strong>project</strong></p>
          {([ ["account", "Account / organization"], ["project", "Project slug"], ["accessKey", "Access key"] ] as const).map(([key, label]) => (
            <label key={key} className="block text-[12px] text-muted">
              {label}
              <input required autoFocus={key === "account"} type={key === "accessKey" ? "password" : "text"} autoComplete="off"
                value={credentials[key]} disabled={busy}
                onChange={(event) => setCredentials({ ...credentials, [key]: event.target.value })}
                className="mt-1 block w-full rounded border border-line bg-base p-2 text-ink focus:outline-none focus:ring-1 focus:ring-accent" />
            </label>
          ))}
          <a href="https://dashboard.tenderly.co/account/authorization" target="_blank" rel="noopener noreferrer" className="text-[12px] text-accent underline">Get a Tenderly access key ↗</a>
          {error && <p role="alert" className="text-[12px] text-fail">{error}</p>}
          <div className="flex items-center justify-end gap-3 pt-2 text-[12px]">
            <button type="button" disabled={busy} onClick={() => {
              try {
                localStorage.removeItem(TENDERLY_STORAGE_KEY);
                setCredentials(EMPTY_CREDENTIALS);
                setError("");
              } catch { setError("Browser storage is unavailable. Allow local storage to forget these settings."); }
            }} className="mr-auto text-dim hover:underline disabled:opacity-50">Forget settings</button>
            <button type="button" disabled={busy} onClick={() => dialog.current?.close()} className="text-muted disabled:opacity-50">Cancel</button>
            <button type="submit" disabled={busy} className="rounded bg-accent px-3 py-2 text-white disabled:opacity-50">
              {busy ? "Simulating…" : proposalId === null ? "Save" : "Save & simulate"}
            </button>
          </div>
        </form>
      </dialog>
    </TenderlyContext.Provider>
  );
}

export function SimulationButton({ proposalId, badge = false }: { proposalId: number; badge?: boolean }) {
  const context = useContext(TenderlyContext);
  if (!context) throw new Error("SimulationButton requires TenderlyProvider");
  return (
    <span className="inline-flex items-center gap-2">
      {badge && <span className="px-1.5 py-0.5 rounded-sm font-mono text-[11px] tracking-wide bg-warn-tint text-warn">simFailed</span>}
      <button type="button" disabled={context.busy} onClick={() => context.simulate(proposalId)}
        aria-label={`Simulate proposal ${proposalId} on Tenderly`}
        className="cursor-pointer text-[12px] text-accent hover:underline disabled:cursor-wait disabled:opacity-50">
        {context.busy ? "Simulating…" : "Simulate ↗"}
      </button>
    </span>
  );
}

export function TenderlySettingsButton() {
  const context = useContext(TenderlyContext);
  return <button type="button" disabled={context?.busy} onClick={() => context?.configure()}
    className="mt-auto p-4 text-left text-[12px] text-muted hover:text-ink disabled:opacity-50">Tenderly settings</button>;
}
