import { z } from 'zod';
import type { ThinkingCapability } from '@/lib/types/provider';

export interface DeclaredModelCapabilities {
  id: string;
  vision?: boolean;
  thinking?: ThinkingCapability;
}

const thinkingCapabilitySchema = z
  .object({
    control: z
      .enum(['none', 'toggle', 'toggle-budget', 'effort', 'level', 'mode', 'budget-only'])
      .optional(),
    requestAdapter: z
      .enum([
        'none',
        'openai',
        'anthropic',
        'google',
        'qwen',
        'deepseek',
        'kimi',
        'glm',
        'siliconflow',
        'doubao',
        'openrouter',
        'hunyuan',
        'xiaomi',
        'lemonade',
      ])
      .optional(),
    defaultMode: z.enum(['default', 'disabled', 'enabled', 'auto']).optional(),
    effortValues: z
      .array(z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']))
      .optional(),
    defaultEffort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
    levelValues: z.array(z.enum(['minimal', 'low', 'medium', 'high'])).optional(),
    defaultLevel: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
    budgetRange: z
      .object({
        min: z.number(),
        max: z.number(),
        step: z.number().optional(),
        allowDynamic: z.boolean().optional(),
        disableValue: z.number().optional(),
      })
      .optional(),
    defaultBudgetTokens: z.number().optional(),
    anthropicThinking: z
      .object({
        type: z.enum(['adaptive', 'enabled']),
        budgetByEffort: z
          .partialRecord(
            z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
            z.number(),
          )
          .optional(),
      })
      .optional(),
    toggleable: z.boolean().optional(),
    budgetAdjustable: z.boolean().optional(),
    defaultEnabled: z.boolean().optional(),
  })
  .strict()
  .refine((capability) => Object.keys(capability).length > 0, {
    message: 'thinking must declare at least one capability field',
  })
  .superRefine((capability, ctx) => {
    if (capability.defaultEffort && !capability.effortValues?.includes(capability.defaultEffort)) {
      ctx.addIssue({ code: 'custom', message: 'defaultEffort must be in effortValues' });
    }
    if (capability.defaultLevel && !capability.levelValues?.includes(capability.defaultLevel)) {
      ctx.addIssue({ code: 'custom', message: 'defaultLevel must be in levelValues' });
    }
    if (
      capability.budgetRange &&
      (capability.budgetRange.min > capability.budgetRange.max ||
        (capability.defaultBudgetTokens !== undefined &&
          (capability.defaultBudgetTokens < capability.budgetRange.min ||
            capability.defaultBudgetTokens > capability.budgetRange.max)))
    ) {
      ctx.addIssue({ code: 'custom', message: 'budget values must be within budgetRange' });
    }
  });

const modelCapabilitySchema = z
  .object({
    id: z.string().trim().min(1),
    vision: z.boolean().optional(),
    thinking: thinkingCapabilitySchema.optional(),
  })
  .strict();

export function parseModelCapabilities(value: unknown) {
  return modelCapabilitySchema.safeParse(value);
}
