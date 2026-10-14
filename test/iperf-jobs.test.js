import test from 'node:test';
import assert from 'node:assert/strict';
import { enqueueDueIperfJobs, handleIperfAdminAction } from '../src/handlers/iperfJobs.js';

function mockDb(schedules = []) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const call = { sql, args: [] };
      calls.push(call);
      const statement = {
        bind(...args) { call.args = args; return statement; },
        async run() { return { meta: { changes: 1 } }; },
        async first() { return sql.includes('FROM servers') ? { id: 'lax' } : null; },
        async all() { return { results: schedules }; }
      };
      return statement;
    }
  };
}

test('北京时间 03:00 只为启用配置创建当日任务', async () => {
  const db = mockDb([{ server_id: 'lax', duration_seconds: 10 }]);
  await enqueueDueIperfJobs(db, Date.parse('2026-10-13T19:00:00Z'));
  const lookup = db.calls.find(x => x.sql.includes('WHERE s.enabled=1'));
  const insertion = db.calls.find(x => x.sql.includes('INSERT OR IGNORE INTO iperf_jobs'));
  assert.equal(lookup.args[0], '03:00');
  assert.equal(lookup.args[1], '03:00');
  assert.equal(lookup.args[2], Date.parse('2026-10-13T18:55:00Z'));
  assert.equal(insertion.args[4], '2026-10-14T03:00+08:00');
});

test('后台拒绝未知目标和过长测速时长', async () => {
  const db = mockDb();
  const invalidDuration = await handleIperfAdminAction({ action: 'iperf_trigger', server_id: 'lax', duration_seconds: 120 }, { DB: db });
  assert.equal(invalidDuration.status, 400);
  const invalidServer = await handleIperfAdminAction({ action: 'iperf_trigger', server_id: '../x', duration_seconds: 10 }, { DB: db });
  assert.equal(invalidServer.status, 400);
  assert.equal(db.calls.some(x => x.sql.startsWith('INSERT INTO iperf_jobs')), false);
});
