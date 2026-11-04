import { createDoasTokenSource } from '../../src/services/feedback-doas-token.js';
const source = createDoasTokenSource(process.argv[2], { psm: 'data.example.service', environment: 'boe' }, process.argv[3]);
const result = await source.refresh(Number(process.argv[4]));
if (result.value !== 'new-token') process.exitCode = 1;
