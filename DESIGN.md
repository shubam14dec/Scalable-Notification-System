# DESIGN.md — Asyncify Dashboard ("Quiet Infrastructure")

## Theme
Dark default (#0a0a0a bg), light via [data-theme=light]. Tokens are the
single source of truth (dashboard/src/styles.css): --bg --surface
--elevated --bd --bd-strong --t1 --t2 --t3 --invert-* --ok --warn --err
--info --accent --focus --overlay. Tailwind v4 @theme inline maps them
(bg-app, bg-surface, bg-elevated, border-bd, text-t1/t2/t3, text-ok etc.).

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
table cells). Modals follow KnowledgeModal/MemoryModal patterns in
Agents.tsx. Sidebar shell in components/Shell.tsx (nav + QueuePulse +
LiveDot).

## Layout
Left sidebar shell; content max-width with dense tables in Cards; detail
views use a two-column split (transcript + right Details panel) as in
Conversations.tsx. Spacing: tight (gap-1.5/2/3), tables are the primary
information surface.

## Motion
Minimal and functional: animate-pulse for live/pending dots, HMR-friendly
transitions on hover (transition-colors). No entrance animations.
Reduced-motion respected by keeping motion near-zero by default.
