import { describe, expect, it } from 'vitest';
import { authorizeFeedbackExtensionChange } from '../src/dashboard/feedback-extension-api.js';

describe('feedback extension API permissions', () => {
  it('requires host execution permission to modify command registrations', () => {
    expect(() => authorizeFeedbackExtensionChange({ hostAdmin: false, manager: true, csrf: true }, 'hooks')).toThrow();
    expect(() => authorizeFeedbackExtensionChange({ hostAdmin: true, manager: true, csrf: false }, 'hooks')).toThrow();
    expect(() => authorizeFeedbackExtensionChange({ hostAdmin: true, manager: true, csrf: true }, 'hooks')).not.toThrow();
  });
  it('allows managers to change presentation without allowing anonymous users', () => {
    expect(() => authorizeFeedbackExtensionChange({ hostAdmin: false, manager: true, csrf: true }, 'presentation')).not.toThrow();
    expect(() => authorizeFeedbackExtensionChange({ hostAdmin: false, manager: false, csrf: true }, 'presentation')).toThrow();
  });
});
