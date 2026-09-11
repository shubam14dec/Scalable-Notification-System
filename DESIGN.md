# DESIGN.md — Asyncify Dashboard ("Quiet Infrastructure")

## Theme
Dark default (#0a0a0a bg), light via [data-theme=light]. Tokens are the
single source of truth (dashboard/src/styles.css): --bg --surface
--elevated --bd --bd-strong --t1 --t2 --t3 --invert-* --ok --warn --err
--info --accent --focus --overlay. Tailwind v4 @theme inline maps them
(bg-app, bg-surface, bg-elevated, border-bd, text-t1/t2/t3, text-ok etc.).
ONE documented exception (U3): the brand panel on the signed-out pages is
theme-INVARIANT — it is a picture of asyncify.org's canvas, so it keeps the
site's near-black in both themes, via four local custom properties on
`.auth-canvas` in styles.css. The form column beside it follows the theme
like everything else. Nowhere else hardcodes hex.

## Typography
Geist Sans 400/500/600 for UI text; Geist Mono 400/500 for identifiers,
numbers, code, timings. Sizes trend small/dense: 12px table text, 13-14px
body, sparing larger headings.

## Color usage
Status ONLY, via STATUS_STYLES + <StatusBadge> (ui.tsx): ok green, info
blue, warn amber, err red, t3 for neutral/skipped; agent statuses:
waiting_human=warn, human=info. Accent (violet) exists but is used
sparingly. Non-status distinctions = fill style (solid vs hollow ring).

## Components (dashboard/src/ui.tsx)
Button, Card (bordered surface, radius-md), EmptyState (teaching copy),
Mono, PageHeader, Skeleton, StatusBadge (dot + 12px label), td/th (dense
table cells), Select (the house dropdown — custom trigger + portaled
listbox, both token-styled; never use a native <select>, its OS-painted
menu ignores the tokens). Modals follow KnowledgeModal/MemoryModal patterns in
Agents.tsx. Sidebar shell in components/Shell.tsx (nav + QueuePulse +
LiveDot).

THIRD-PARTY UI wears the house idiom or it does not ship. The first of it
(U5: driver.js, the first-run guided tour) arrives as a white, rounded,
drop-shadowed bubble with 19px bold titles; it is dragged onto the tokens in
a marked block at the bottom of styles.css — bg-surface + one 1px border-bd,
radius-md, NO shadow, 13px text, monochrome ghost/primary buttons, progress
count in mono t3 — and scoped to its own popoverClass so the override says
what it is overriding. The rule generalizes: a vendor stylesheet is a
starting point, never a second design system, and the overrides live in
styles.css with the tokens rather than in the component.

## Layout
Left sidebar shell; content max-width with dense tables in Cards; detail
views use a two-column split (transcript + right Details panel) as in
Conversations.tsx. Spacing: tight (gap-1.5/2/3), tables are the primary
information surface.

## Motion
Minimal and functional: animate-pulse for live/pending dots, HMR-friendly
transitions on hover (transition-colors). No entrance animations.
Reduced-motion respected by keeping motion near-zero by default.

The signed-out pages (U3) are the one place motion is allowed to be
expressive, because they are the product's front door and carry no data:
the mark breathes, the proof ticker drifts, the hairline draws once, receipt
lines arrive in order, and a successful sign-in rings the mark before it
navigates. All of it is CSS keyframes in styles.css (no library, no rAF, no
canvas), every animation is switched OFF — not merely shortened — under
prefers-reduced-motion, and the sign-in ring never delays a navigation for
anyone who cannot see it (reduced motion or a viewport under 900px goes
straight through). Nothing inside the app shell changes.
