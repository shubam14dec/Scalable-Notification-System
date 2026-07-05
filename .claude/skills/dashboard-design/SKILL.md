---
name: dashboard-design
description: Design system for the notification dashboard (dashboard/ folder) — Geist-inspired monochrome tokens, typography, status semantics. Read before writing or changing ANY dashboard UI so the design never drifts.
---

# Dashboard Design System — "Quiet Infrastructure"

Vercel-Geist-inspired. The chrome is monochrome and disciplined; **color is
reserved exclusively for delivery-status meaning**. If a diff adds color to a
button, border, or background that isn't a status, it's wrong.

## Tokens (CSS variables in dashboard/src/styles.css — single source of truth)

Dark (default showcase):
- bg `#0a0a0a` · surface `#111111` · elevated `#171717`
- border `#262626` · border-strong `#3f3f3f`
- text `#ededed` · text-2 `#a1a1a1` · text-3 `#6e6e6e`
Light:
- bg `#ffffff` · surface `#fafafa` · elevated `#ffffff`
- border `#eaeaea` · border-strong `#d4d4d4`
- text `#171717` · text-2 `#666666` · text-3 `#8f8f8f`

Status (the ONLY colors allowed to carry meaning; consistent everywhere):
- success (sent/delivered) `#3dd68c` dark / `#009159` light
- warn (retry/deferred)    `#ffb224` dark / `#ad5700` light
- error (failed/bounced)   `#ff6369` dark / `#dc3d43` light
- info (queued/sending)    `#52a9ff` dark / `#0070f3` light
- muted (skipped/merged)   text-3

Brand accent `#8b5cf6` (violet): ONLY the logo mark and the active-nav
indicator. Never on buttons, links, charts, or backgrounds.

## Rules

1. **Buttons are monochrome.** Primary = inverted (white on dark theme, black
   on light). Secondary = transparent + 1px border. No colored buttons, ever.
2. **Borders, not shadows.** Depth = background step + 1px border. No
   box-shadow except focus rings and dialog overlay.
3. **Typography:** Geist Sans for UI; **Geist Mono for every technical value**
   (IDs, keys, addresses, timestamps, JSON, counts in tables). Sizes: 13px
   base UI, 12px table/mono, 15px section titles, 20px page titles. Weight
   does hierarchy; avoid more sizes.
4. **Status language:** one `<StatusBadge>` component maps message/event
   states to dot+label; never restyle statuses ad hoc.
5. **Density:** compact rows (36-40px), airy page chrome (24-32px paddings).
   Tables show many rows; the frame stays calm.
6. **Motion:** 150ms ease fades/slides only. Skeletons over spinners.
   Respect prefers-reduced-motion. Nothing bounces.
7. **Radius:** 6px controls, 8px cards. 1px borders everywhere.
8. **Copy:** sentence case, active voice, subject vocabulary (workflows,
   subscribers, environments). Empty states teach: show the curl/SDK snippet
   that fills the screen. Errors say what happened + what to do.
9. **Both themes always.** Every new component must be checked in dark AND
   light (tokens only — no hardcoded hex in components).
10. **Signature element:** the live queue pulse in the sidebar footer (tiny
    monochrome bars, 5s poll). Keep it subtle; never enlarge it into a chart.
11. **Focus visible everywhere:** 2px outline `--focus` on :focus-visible.
12. **Icons:** lucide-react, 16px, stroke 1.5, text-2 color. No emoji in UI.
