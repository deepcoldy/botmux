import { describe, expect, it } from 'vitest';
import { feedbackSupabaseSchemaSql } from '../src/services/feedback-supabase-schema.js';

const instanceId = '54b7e556-dd56-4018-99f9-a6c84f3d5c47';

describe('Supabase feedback installation input', () => {
  it.each(['', 'Public', 'a.b', 'a";drop schema public;--', 'a'.repeat(64)])('rejects unsafe schema %j', schema => {
    expect(() => feedbackSupabaseSchemaSql(schema, instanceId)).toThrow('feedback_storage_schema_invalid');
  });
  it.each(['', 'not-a-uuid', `${instanceId}'`, '54b7e556dd56401899f9a6c84f3d5c47'])('rejects invalid instance %j', invalid => {
    expect(() => feedbackSupabaseSchemaSql('feedback_test', invalid)).toThrow('feedback_storage_instance_invalid');
  });
});
