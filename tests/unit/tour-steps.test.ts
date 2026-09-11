/**
 * Slice U5 drift guard — the guided tour's stop list against the sidebar it
 * points at.
 *
 * A tour breaks SILENTLY. Rename a `data-tour` handle in Shell.tsx, or drop one
 * while reshuffling the nav, and nothing fails to compile, no test goes red,
 * and the first anyone hears about it is a new customer watching a spotlight
 * skip a stop (or worse, land on the wrong row). So this file asserts the two
 * halves still agree: every selector in TOUR_STEPS resolves to a handle
 * Shell.tsx actually renders, and the stop ORDER is the one that was approved.
 *
 * Deliberately NOT a rendering test. Verification of the tour's behaviour in a
 * browser is the user's manual E2E; this is the cheap half that a machine can
 * hold onto.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { TOUR_STEPS } from '../../dashboard/src/lib/tour';

const shellSource = readFileSync(
  resolve(__dirname, '../../dashboard/src/components/Shell.tsx'),
  'utf8',
);

/**
 * Every `data-tour` handle the sidebar renders. Two shapes, because the nav
 * items build theirs from the NAV table (`tour: 'workflows'` ->
 * `data-tour="nav-workflows"`) while the environment switcher carries a literal
 * attribute.
 */
const renderedHandles = new Set<string>([
  ...[...shellSource.matchAll(/data-tour="([a-z-]+)"/g)].map((m) => m[1]),
  ...[...shellSource.matchAll(/\btour: '([a-z-]+)'/g)].map((m) => `nav-${m[1]}`),
]);

/** The `data-tour` value each step points at. */
const targets = TOUR_STEPS.map((step) => {
  const selector = String(step.element);
  const match = /^\[data-tour="([a-z-]+)"\]$/.exec(selector);
  expect(match, `step selector is not a data-tour handle: ${selector}`).toBeTruthy();
  return match![1];
});

describe('the seven stops', () => {
  test('are the approved seven, in the approved order', () => {
    expect(targets).toEqual([
      'env',
      'nav-workflows',
      'nav-connections',
      'nav-agents',
      'nav-keys',
      'nav-inbox-preview',
      'nav-activity',
    ]);
  });

  test('each has a title and a description', () => {
    for (const step of TOUR_STEPS) {
      expect(step.popover?.title, `missing title on ${String(step.element)}`).toBeTruthy();
      expect(
        step.popover?.description,
        `missing description on ${String(step.element)}`,
      ).toBeTruthy();
    }
  });

  test('sit to the right of the sidebar, top-aligned with their row', () => {
    // Pinned rather than left to driver's automatic placement: every target is
    // a row in a fixed left column, so "right" is the only correct answer and
    // an auto-flip would drop the popover on top of the thing it describes.
    for (const step of TOUR_STEPS) {
      expect(step.popover?.side).toBe('right');
      expect(step.popover?.align).toBe('start');
    }
  });
});

describe('the stops agree with the sidebar', () => {
  test('every target is a handle Shell.tsx renders', () => {
    for (const target of targets) {
      expect(
        renderedHandles.has(target),
        `Shell.tsx renders no data-tour="${target}" — the tour would skip this stop`,
      ).toBe(true);
    }
  });

  test('no selector is positional', () => {
    // nth-child would be quietly correct today and quietly wrong the first time
    // someone reorders the nav or hides an item for a non-operator.
    for (const step of TOUR_STEPS) {
      expect(String(step.element)).not.toMatch(/nth-child|:first|:last|>|\s/);
    }
  });

  test('no stop is visited twice', () => {
    expect(new Set(targets).size).toBe(targets.length);
  });
});
