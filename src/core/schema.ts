import { z } from 'zod';

export const ProbeRecordSchema = z.object({
  at: z.string(), // ISO timestamp
  severity: z.enum(['ok', 'warn', 'error']),
  title: z.string(),
  detail: z.string().optional(),
});

export type ProbeRecord = z.infer<typeof ProbeRecordSchema>;

export const ProfileSchema = z.object({
  env: z.record(z.string(), z.string()),
  meta: z
    .object({
      description: z.string().optional(),
      createdAt: z.string().optional(),
      updatedAt: z.string().optional(),
      lastProbe: ProbeRecordSchema.optional(),
    })
    .optional(),
});

export type Profile = z.infer<typeof ProfileSchema>;

export const SettingsSchema = z
  .object({
    env: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

export type Settings = z.infer<typeof SettingsSchema>;

export const OauthAccountSchema = z.object({
  accountUuid: z.string(),
  emailAddress: z.string(),
  organizationUuid: z.string(),
});

export type OauthAccount = z.infer<typeof OauthAccountSchema>;

export const ClaudeJsonSchema = z
  .object({
    hasCompletedOnboarding: z.boolean().optional(),
    lastOnboardingVersion: z.string().optional(),
    oauthAccount: OauthAccountSchema.optional(),
  })
  .passthrough();

export type ClaudeJson = z.infer<typeof ClaudeJsonSchema>;
