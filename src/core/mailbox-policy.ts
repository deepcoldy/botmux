import { z } from 'zod';

// Mirror dispatchLaunchPolicy: versioned, strict, explicit opt-in. Registry
// ignores invalid values; runtime only admits enabled === true.
const mailboxPolicySchema = z.object({ schemaVersion: z.literal(1), enabled: z.boolean() }).strict();
export type MailboxPolicy = z.infer<typeof mailboxPolicySchema>;
export function normalizeMailboxPolicy(raw: unknown): MailboxPolicy {
  return mailboxPolicySchema.parse(raw);
}
