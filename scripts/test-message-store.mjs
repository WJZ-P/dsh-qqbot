// 本地自测：node scripts/test-message-store.mjs
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import assert from 'node:assert/strict';
import { MessageStore, messageRecorder } from '../dist/features/message-store.js';

const path = join(tmpdir(), `qqbot-msg-test-${Date.now()}.db`);
const store = new MessageStore(path);
const pragma = (q) => Object.values(store.db.prepare(q).get())[0];
assert.equal(pragma('PRAGMA journal_mode'), 'wal');
assert.equal(Number(pragma('PRAGMA synchronous')), 1);
assert.equal(Number(pragma('PRAGMA busy_timeout')), 5000);
assert.equal(Number(pragma('PRAGMA foreign_keys')), 1);

const mk = (i, group, user, ageDays = 0) => ({
  messageId: `m${i}`, kind: group ? 'group' : 'c2c', groupOpenid: group, senderId: user,
  content: `hello ${i}`, timestamp: new Date().toISOString(), raw: { id: `m${i}`, extra: { a: i } },
  _at: Date.now() - ageDays * 86_400_000,
});
const msgs = [
  mk(1, 'G1', 'U1'), mk(2, 'G1', 'U2'), mk(3, 'G1', 'U1', 40), mk(4, 'G2', 'U3'), mk(5, null, 'U9'),
];
// 中间件路径 + 幂等
const mw = messageRecorder(store, console);
for (const m of msgs) await mw({ message: m, receivedAt: m._at }, async () => {});
await mw({ message: msgs[0], receivedAt: Date.now() }, async () => {});
let s = store.stats();
assert.equal(s.total, 5);
assert.deepEqual(s.groups.map((g) => [g.groupOpenid, g.count, g.users]), [['G1', 3, 2], ['G2', 1, 1]]);
assert.equal(s.c2c[0].userOpenid, 'U9');
assert.equal(JSON.parse(store.db.prepare('SELECT raw FROM messages WHERE msg_id = ?').get('m3').raw).extra.a, 3);

// 批量事务
const t0 = Date.now();
const batch = Array.from({ length: 10000 }, (_, i) => MessageStore.recordOf(mk(1000 + i, 'G3', 'U' + (i % 7))));
assert.equal(store.insertMany(batch), 10000);
console.log(`10000 rows in tx: ${Date.now() - t0}ms`);

assert.equal(store.recent('group', 'G1', 2).length, 2);
assert.equal(store.clear({ kind: 'older', days: 30 }), 1);
assert.equal(store.clear({ kind: 'group', id: 'G3' }), 10000);
assert.equal(store.clear({ kind: 'c2c', id: 'U9' }), 1);
s = store.stats();
assert.equal(s.total, 3);
assert.equal(store.clear({ kind: 'all' }), 3);
console.log('stats after clear', store.stats());
store.close();
for (const suf of ['', '-wal', '-shm']) rmSync(path + suf, { force: true });
console.log('OK');
