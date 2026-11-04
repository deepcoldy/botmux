// Loads every feedback module on the daemon / `botmux send` static path. Under
// the block-pg resolve hook these must still import successfully with the
// default SQLite backend (pg is optional and must stay lazy).
await import('../../src/services/skill-feedback-store.js');
await import('../../src/services/feedback-maintenance.js');
await import('../../src/services/feedback-recovery.js');
await import('../../src/services/turn-completion-events.js');
await import('../../src/services/feedback-webhook-dispatcher.js');
console.log('feedback hot path loads without pg');
