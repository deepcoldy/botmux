import { SkillFeedbackStore } from '../../src/services/skill-feedback-store.js';

const store = await SkillFeedbackStore.open(process.argv[2]);
process.send?.({ ready: true });
process.on('message', () => {
  try {
    store.createResponse({ interactionId: 'child', content: 'after-freeze' });
    process.send?.({ accepted: true });
  } catch (error) {
    process.send?.({ error: (error as Error).message });
  } finally {
    store.close();
    process.disconnect?.();
  }
});
