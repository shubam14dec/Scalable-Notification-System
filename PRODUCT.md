# PRODUCT.md — Asyncify Dashboard

## Register
product — app UI / ops dashboard. Design SERVES the product.

## Users & Purpose
- **Priya** (engineer at "Acme"): configures agents, workflows, templates,
  integrations, knowledge. Wants density, precision, zero ambiguity.
- **Sam** (support lead): watches conversations live, approves risky agent
  actions, takes over conversations (HITL), manages agent memory.
- Context: long sessions, second-monitor usage, frequent glancing — the
  dashboard must be calm at rest and legible at a glance.

## Brand personality
"Quiet Infrastructure" — calm, dense, monospace-numeric, engineered.
Three words: precise, quiet, trustworthy.

## Strategic design principles
1. **Color is status, minted once.** The ONLY color on a screen is status
   dots/badges via STATUS_STYLES (ui.tsx). Everything else is neutral.
   Source distinctions use FILL STYLE (solid dot vs hollow ring), not color.
2. **Numbers are mono.** Geist Mono for ids, counts, tokens, timings.
3. **Live over polled.** Surfaces update via WS invalidation hints (P25);
   the sidebar dot shows liveness; degraded mode is visible, never silent.
4. **Teaching empty states.** Every empty view says what will appear and
   how to cause it.
5. **Both themes always.** Dark is default; [data-theme=light] must be
   equally correct. Tokens only — no hardcoded colors.

## Anti-references
- SaaS gradient-dashboard aesthetics; hero metrics; card grids for
  everything; color as decoration; toasts for information that belongs
  inline.

## Accessibility
Baseline: full keyboard nav, visible focus (--focus), >=4.5:1 body
contrast in both themes.
