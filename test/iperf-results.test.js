import test from 'node:test';
import assert from 'node:assert/strict';
import { validateIperfResult, handleIperfReport } from '../src/handlers/iperf.js';

const good = {
  run_id: '20261013T120000Z-a1b2c3d4', server_id: 'aws-hkg', source: 'deb',
  family: 'ipv4', direction: 'download', tested_at: Date.now(),
  duration_seconds: 30, port: 5202, status: 'ok', mbps: 250.5, retransmits: 3
};

test('测速结果区分成功、无响应和缺失指标', () => {
  assert.equal(validateIperfResult(good)?.mbps, 250.5);
  assert.equal(validateIperfResult({ ...good, status: 'no_response', mbps: null, retransmits: null })?.status, 'no_response');
  assert.equal(validateIperfResult({ ...good, status: 'failed', mbps: 0, retransmits: null }), null);
  assert.equal(validateIperfResult({ ...good, retransmits: null }), null);
});

test('上报没有独立密钥时拒绝，且不触碰数据库', async () => {
  const request = new Request('https://example.com/api/iperf/report', { method: 'POST', body: JSON.stringify(good) });
  const response = await handleIperfReport(request, { DB: null, IPERF_REPORT_TOKEN: 'secret' });
  assert.equal(response.status, 401);
});
