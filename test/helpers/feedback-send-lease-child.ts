import { acquireFeedbackSendLease } from '../../src/services/feedback-maintenance.js';

acquireFeedbackSendLease(process.argv[2]);
process.send?.({ ready: true });
setInterval(() => {}, 1000);
