import { loadEnv } from './env.js';
import { createPool, migrate } from './db.js';

loadEnv();

const pool = createPool();
try {
  await migrate(pool);
  console.log('schema applied');
} finally {
  await pool.end();
}
