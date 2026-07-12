import { z } from 'zod';

/** One selectable choice inside a `select` card. */
export const CardOptionSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(48),
});

/**
 * A card is the richer sibling of buttons: a reply may carry buttons XOR one
 * card. `select` renders as a native dropdown/keyboard; `text_input` as a
 * native free-text field. Both come back to the brain as `raw.action` events
 * (kind 'select'/'input'), the same pipeline button clicks use.
 */
export const CardSchema = z
  .discriminatedUnion('type', [
    z.object({
      type: z.literal('select'),
      id: z.string().min(1).max(64),
      prompt: z.string().min(1).max(200).optional(),
      options: z.array(CardOptionSchema).min(2).max(25),
    }),
    z.object({
      type: z.literal('text_input'),
      id: z.string().min(1).max(64),
      prompt: z.string().min(1).max(200).optional(),
      placeholder: z.string().min(1).max(64).optional(),
    }),
  ])
  // Duplicate option ids can't be checked inside a discriminated-union member:
  // `.superRefine` on the object turns it into a ZodEffects, which the union
  // builder rejects. So the check rides the whole union and inspects only
  // select cards (the only variant with options).
  .superRefine((card, ctx) => {
    if (card.type !== 'select') return;
    const seen = new Set<string>();
    for (const opt of card.options) {
      if (seen.has(opt.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate option ids: ${opt.id}`,
          path: ['options'],
        });
      }
      seen.add(opt.id);
    }
  });

export type Card = z.infer<typeof CardSchema>;
export type CardOption = z.infer<typeof CardOptionSchema>;
