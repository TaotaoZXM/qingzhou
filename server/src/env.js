import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

export function loadEnv() {
  dotenv.config({ path: join(serverRoot, '.env') });
  dotenv.config({ path: join(serverRoot, '..', '.env') });
}
