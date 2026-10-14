import test from 'node:test';
import assert from 'node:assert/strict';
import { handleIperfResults } from '../src/handlers/iperf.js';

// Node 24 可直接用 SQLite 验证 D1 查询；较旧 Node 跳过这组数据库集成测试。
const { DatabaseSync } = await import('node:sqlite').catch(() => ({}));

function database() {
  const sqlite = new DatabaseSync(':memory:');
  return { sqlite, DB: { prepare(sql) {
    let params = [];
    return {
      bind(...values) { params = values; return this; },
      async run() { return sqlite.prepare(sql).run(...params); },
      async first() { return sqlite.prepare(sql).get(...params) ?? null; },
      async all() { return { results: sqlite.prepare(sql).all(...params) }; },
    };
  } } };
}

test('历史分页按完整批次返回，可翻到超过最近 20 次的记录，且隔离节点', { skip: !DatabaseSync }, async () => {
  const { DB, sqlite } = database();
  try {
    const read = (query) => handleIperfResults(new Request(`https://example.com/api/iperf/results?id=node-a&${query}`), { DB }, { is_public: 'true' });
    await read('view=history');
    const insert = sqlite.prepare('INSERT INTO iperf_results VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (let run = 0; run < 28; run++) {
      for (const family of ['ipv4', 'ipv6']) for (const direction of ['download', 'upload']) {
        insert.run(`run-${String(run).padStart(2, '0')}`, 'node-a', 'deb', family, direction, 1000 + run, 10, 5202, 'ok', run, 0, null);
        insert.run(`run-${String(run).padStart(2, '0')}`, 'node-b', 'deb', family, direction, 2000 + run, 10, 5202, 'ok', 999, 0, null);
      }
    }
    const first = await (await read('view=history&page=1&page_size=5')).json();
    const second = await (await read('view=history&page=2&page_size=5')).json();
    const last = await (await read('view=history&page=999&page_size=5')).json();
    assert.equal(first.total_runs, 28);
    assert.equal(first.rows.length, 20);
    assert.equal(new Set(first.rows.map(row => row.run_id)).size, 5);
    assert.ok(first.rows.every(row => row.server_id === 'node-a'));
    assert.ok(second.rows.every(row => !first.rows.some(previous => previous.run_id === row.run_id)));
    assert.equal(last.page, 6);
    assert.equal(last.rows.length, 12);
    assert.ok(last.rows.some(row => row.run_id === 'run-00'));
    const latest = await (await read('')).json();
    assert.ok(Array.isArray(latest));
    assert.equal(latest.length, 80);
    assert.equal((await read('view=history&page=-1')).status, 400);
    assert.equal((await read('view=history&page_size=500')).status, 400);
  } finally { sqlite.close(); }
});

test('历史分页保留认证要求', async () => {
  const response = await handleIperfResults(new Request('https://example.com/api/iperf/results?id=node-a&view=history'), { DB: null }, { is_public: 'false' });
  assert.equal(response.status, 401);
});
