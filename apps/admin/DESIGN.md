# Admin Dashboard Design

This document covers the design decisions behind the admin UI so future changes stay coherent.

## What this is

An internal ops tool used by engineers during incidents and routine debugging. Users are staring at proposal lifecycles, transaction hashes, queue depths, and audit trails — often under pressure. The interface should be fast to read, never distracting.

## Token system

All colors, type sizes, and spacing decisions derive from tokens defined in `src/app/globals.css` via Tailwind's `@theme inline`. Use these — do not reach for `text-gray-500` or other ad-hoc values.

### Colors

| Token | Value | Use |
|---|---|---|
| `bg-base` | `#F5F6F8` | Page background |
| `bg-surface` | `#FFFFFF` | Cards, panels, tables, sidebar |
| `border-line` | `#E2E7EF` | All borders and dividers |
| `text-ink` | `#111827` | Primary text, data values |
| `text-muted` | `#64748B` | Secondary text, addresses in tables |
| `text-dim` | `#94A3B8` | Labels, metadata, empty states |
| `text-accent` / `bg-accent` | `#2563EB` | Links, active nav, buttons, event type badges |
| `bg-accent-tint` | `#EFF6FF` | Active nav background, badge backgrounds |
| `text-ok` / `bg-ok-tint` | `#059669` / `#ECFDF5` | Settled, success states |
| `text-warn` / `bg-warn-tint` | `#B45309` / `#FFFBEB` | Executing, simFailed, pending |
| `text-fail` / `bg-fail-tint` | `#DC2626` / `#FEF2F2` | Rejected, reverted, penalized |

### Typography

Geist Sans for all UI chrome. **Geist Mono is the hero** — every data value uses it: addresses, tx hashes, amounts, IDs, timestamps, status values, queue depths.

Labels (field names, table headers, section titles): `text-[10px] uppercase tracking-widest text-dim font-medium`. This creates a clear two-tier hierarchy where labels are infrastructure and values are content.

Data values in tables: `font-mono text-[12px]`. Audit trail event types: `font-mono text-[11px]`.

Never use `text-xl font-bold` for page titles. Page titles are `text-[13px] font-semibold text-ink`.

## Layout

**Sidebar, not top nav.** This is a debugging tool with four equally-used sections. Sidebar gives persistent spatial orientation — you know where you are while reading a proposal detail or an audit trail. Top nav is a marketing/blog pattern.

Sidebar: `w-[184px]`, `bg-surface`, `border-r border-line`. Header area has the BYOS wordmark in mono. Nav links span the full sidebar width with `border-l-2` always present (transparent when inactive, accent when active) — this is the signature element of the design. No layout shift between states.

Content area: `bg-base`, `p-8`. Pages do not constrain their own width except detail/form pages which use `max-w-3xl`.

## Panels

The base pattern for any content section:

```tsx
<div className="bg-surface border border-line rounded">
  <div className="px-5 py-3 border-b border-line">
    <span className="text-[10px] uppercase tracking-widest text-dim font-medium">Section title</span>
  </div>
  <div className="p-5">
    {/* content */}
  </div>
</div>
```

No box shadows. No border-radius above `rounded` (4px). No `rounded-lg`.

## Tables

```tsx
<div className="bg-surface border border-line rounded overflow-hidden">
  <table className="w-full">
    <thead>
      <tr className="bg-base border-b border-line">
        <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-dim font-medium">
          Column
        </th>
      </tr>
    </thead>
    <tbody>
      <tr className="border-b border-line last:border-0 hover:bg-base transition-colors duration-100">
        <td className="px-4 py-3 font-mono text-[12px] text-muted">value</td>
      </tr>
    </tbody>
  </table>
</div>
```

Key rules: `last:border-0` removes the orphan bottom border. `hover:bg-base` not `hover:bg-gray-50`. No alternating row stripes. All transitions at `duration-100`.

## Status badges

```tsx
const BADGE_STYLES: Record<string, string> = {
  settled:      "bg-ok-tint text-ok",
  active:       "bg-accent-tint text-accent",
  submitted:    "bg-base text-muted",
  executing:    "bg-warn-tint text-warn",
  rejected:     "bg-fail-tint text-fail",
  settleFailed: "bg-fail-tint text-fail",
  simFailed:    "bg-warn-tint text-warn",
  penalized:    "bg-fail-tint text-fail",
  expired:      "bg-base text-dim",
  cancelled:    "bg-base text-dim",
};

// base class:
"inline-flex items-center px-1.5 py-0.5 rounded-sm font-mono text-[11px] tracking-wide"
```

`rounded-sm` (2px), not `rounded`. Mono text. If the badge links somewhere (e.g. Tenderly), add `hover:underline` to the anchor — same class, no visual difference at rest.

## Interactive elements

All `<a>` and `<button>` elements inherit `transition: color/background/border 100ms ease` from `globals.css`. Do not add extra transition classes — they're already there.

Buttons: `bg-accent text-white text-[12px] font-medium px-3 py-1.5 rounded hover:opacity-90`.

Inputs and selects: `border border-line rounded bg-surface font-mono text-[12px] text-ink px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent`.

Text links: `text-accent hover:underline`. Back links and secondary links: `text-muted hover:text-ink hover:underline`.

## Funnel bar colors

Bars use `bg-accent` (blue) as the "positive/continuing" segment and `bg-warn` (amber) as the "dropped/failed" segment across all three bars. `bg-muted` (slate gray) is used for the "lost" segment in bar 2.

**Why blue + amber, not green + red:** Green/red is the classic deuteranopia trap — roughly 8% of men can't distinguish them. Blue and amber differ in both hue and luminance and remain distinguishable across all common color-vision deficiencies. The consistent use of blue for the "kept" cohort and amber for the "dropped" cohort also encodes meaning: blue always means "still in play", amber always means "fell out here".

Do not reintroduce `bg-fail-tint` (near-white) for bar segments — it lacks contrast and is effectively invisible as a filled bar.

## What to avoid

- `bg-white rounded-lg border border-gray-200 p-5` — the shadcn/Tailwind default card. Use the Panel pattern above.
- `text-gray-*`, `border-gray-*`, `bg-gray-*` — use the named tokens.
- Box shadows.
- `rounded-lg` or higher.
- `text-xl font-bold` for headings.
- Big-number stat cards with label below — put the label above in small-caps.
- Decorative elements that don't encode information.
