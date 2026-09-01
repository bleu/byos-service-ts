function toDatetimeLocal(iso: string): string {
  return iso.slice(0, 16);
}

const INPUT_CLS =
  "border border-line rounded bg-surface font-mono text-[12px] text-ink px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent";

const BUTTON_CLS =
  "bg-accent text-white text-[12px] font-medium px-3 py-1.5 rounded hover:opacity-90";

const LABEL_CLS =
  "block text-[10px] uppercase tracking-widest text-dim font-medium mb-1";

export function DateRangeForm({
  from,
  to,
  resetHref,
}: {
  from: string;
  to: string;
  resetHref: string;
}) {
  return (
    <form method="GET" className="flex items-end gap-2">
      <div>
        <label className={LABEL_CLS}>From (UTC)</label>
        <input
          type="datetime-local"
          name="from"
          defaultValue={toDatetimeLocal(from)}
          className={INPUT_CLS}
        />
      </div>
      <div>
        <label className={LABEL_CLS}>To (UTC)</label>
        <input
          type="datetime-local"
          name="to"
          defaultValue={toDatetimeLocal(to)}
          className={INPUT_CLS}
        />
      </div>
      <button type="submit" className={BUTTON_CLS}>
        Apply
      </button>
      <a href={resetHref} className="text-[12px] text-dim hover:text-muted underline pb-1.5">
        Reset
      </a>
    </form>
  );
}
