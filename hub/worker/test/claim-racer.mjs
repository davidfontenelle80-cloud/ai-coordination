// claim-racer.mjs — worker thread for the simultaneous-claim race test.
// Opens its own connection to the shared file DB and attempts one append.
import { parentPort, workerData } from 'node:worker_threads';
import { openDb } from '../src/sqlite-db.mjs';
import { appendEvent } from '../src/event-core.mjs';

const { dbPath, input } = workerData;
let res;
const db = openDb(dbPath);
try {
  res = await appendEvent(db, input);
} finally {
  db.close();
}
if (res.ok) {
  parentPort.postMessage({ ok: true, replayed: !!res.replayed, event_id: res.event.event_id });
} else {
  parentPort.postMessage({ ok: false, code: res.code, current: res.current_task_version });
}
