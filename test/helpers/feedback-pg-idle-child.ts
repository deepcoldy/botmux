import { feedbackPostgresPool } from '../../src/services/feedback-postgres-schema.js';

const url = new URL(process.env.BOTMUX_TEST_POSTGRES_URL!);
const pool = feedbackPostgresPool({
  host: url.hostname, port: Number(url.port || 5432), database: url.pathname.slice(1), user: decodeURIComponent(url.username), schema: 'public',
  passwordRef: 'env:UNUSED', tls: { mode: 'disable' }, connectTimeoutMs: 3000,
}, 'synthetic-idle-secret');
const client = await pool.connect();
const backend = (await client.query('SELECT pg_backend_pid() pid')).rows[0].pid;
client.release();
process.send?.({ backend });
process.on('message', async () => {
  try {
    await new Promise(resolve => setTimeout(resolve, 100));
    await pool.query('SELECT 1');
    await pool.end();
    process.send?.({ recovered: true });
  } finally { process.disconnect?.(); }
});
