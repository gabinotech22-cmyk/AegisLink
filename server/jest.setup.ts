/**
 * Global test teardown.
 *
 * Closes the database after EVERY test file so the native `node:sqlite` handle
 * (and any pg pool) never outlives the Jest environment. As a setupFilesAfterEnv
 * module this `afterAll` is registered before each test file's own hooks, so it
 * runs LAST — after the suites' server/socket teardown — preventing the
 * post-teardown "import after teardown" / `ENOENT 'sqlite'` cascade that was
 * failing 8/9 server suites.
 */
import { closeDb } from './src/db/client.js';

afterAll(async () => {
  await closeDb();
});
