// 从 SAO networkEstimate.ts 生成；v0.5 当前评分，两端同步更新。
const HOUR = 3600_000;
export const CURRENT_WINDOW_MS = 10 * 60_000;
export function recentProbe(probe, now) {
    const inside = (time) => valid(time) && time >= now - CURRENT_WINDOW_MS && time <= now;
    const samples = probe.samples?.filter(row => inside(row.time));
    const losses = (probe.lossSamples ?? probe.samples)?.filter(row => inside(row.time));
    let total = 0, sum = 0;
    for (const row of losses || [])
        if (valid(row.loss) && row.loss >= 0 && row.loss <= 100) {
            const count = valid(row.count) && row.count > 0 ? Math.min(60, row.count) : 1;
            sum += row.loss * count;
            total += count;
        }
    return { ...probe, samples, emptyTimes: probe.emptyTimes?.filter(inside),
        loss: total ? sum / total : !probe.samples?.length && !probe.lossSamples?.length ? probe.loss : null };
}
const valid = (value) => typeof value === "number" && Number.isFinite(value);
export function aimPoints(value, thresholds, points) {
    let i = 0;
    while (i < thresholds.length && value >= thresholds[i])
        i++;
    return points[i];
}
function curve(value, anchors) {
    if (value <= anchors[0][0])
        return anchors[0][1];
    for (let i = 1; i < anchors.length; i++) {
        const [x1, y1] = anchors[i - 1], [x2, y2] = anchors[i];
        if (value <= x2)
            return y1 + (y2 - y1) * (value - x1) / (x2 - x1);
    }
    return anchors[anchors.length - 1][1];
}
export const latencyScore = (ms) => curve(Math.ceil(ms / 10) * 10, [[0, 100], [50, 90], [100, 75], [150, 60], [200, 45], [300, 20], [500, 0]]);
export const bandwidthScore = (mbps) => curve(Math.log1p(mbps), [[0, 0], [1, 5], [10, 15], [50, 30], [100, 40], [200, 55], [300, 65], [500, 80], [1000, 95], [2000, 100]].map(([x, y]) => [Math.log1p(x), y]));
export const failureScore = (pct) => curve(pct, [[0, 100], [0.1, 98], [0.5, 90], [1, 80], [2, 65], [5, 35], [10, 10], [20, 0]]);
// 自定义轻微惩罚，不是 TCP 丢包率。传输量由 Mbps×配置时长近似，过小样本不计。
export function retransmissionCost(row) {
    if (!row || row.status !== "ok" || !valid(row.mbps) || !valid(row.duration_seconds) || row.duration_seconds <= 0 || !valid(row.retransmits) || !Number.isSafeInteger(row.retransmits) || row.retransmits < 0)
        return null;
    const estimatedMiB = row.mbps * 1_000_000 * row.duration_seconds / 8 / 1048576;
    if (estimatedMiB < 1)
        return null;
    const perMiB = row.retransmits / estimatedMiB;
    const penalty = curve(Math.log1p(perMiB), [[0, 0], [1, 0.1], [10, 0.5], [100, 2], [500, 3]].map(([x, y]) => [Math.log1p(x), y]));
    return { count: row.retransmits, estimatedMiB, perMiB, penalty };
}
const variationScore = (ms) => curve(ms, [[0, 100], [5, 95], [10, 85], [20, 65], [40, 35], [80, 10], [150, 0]]);
function median(values) {
    const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
export function isPeakTime(time) {
    const hour = new Date(time + 8 * HOUR).getUTCHours();
    return hour >= 20 && hour < 23;
}
export function probeVariation(probe, now) {
    const samples = new Map();
    for (const row of probe.samples || []) {
        if (row.time < now - CURRENT_WINDOW_MS || row.time > now || !valid(row.time))
            continue;
        samples.set(row.time, { time: row.time, value: valid(row.value) && row.value >= 0 && row.loss !== 100 ? row.value : null,
            count: valid(row.count) && row.count > 0 ? Math.min(60, row.count) : 1 });
    }
    for (const time of probe.emptyTimes || [])
        if (time >= now - CURRENT_WINDOW_MS && time <= now)
            samples.set(time, { time, value: null, count: 1 });
    const ordered = [...samples.values()].sort((a, b) => a.time - b.time);
    const values = ordered.filter((row) => row.value != null);
    const quantile = (q) => {
        const sorted = [...values].sort((a, b) => a.value - b.value);
        const total = sorted.reduce((sum, row) => sum + row.count, 0);
        let count = 0;
        for (const row of sorted) {
            count += row.count;
            if (count >= q * total)
                return row.value;
        }
        return null;
    };
    const p50 = quantile(0.5), p95 = quantile(0.95);
    const differences = [];
    // 失败与空档断开配对；不把跨长时间缺口的两点当作相邻采样。
    const maxGap = Math.max(10 * 60_000, Math.min(10 * 60_000, probe.metricIntervalMs || 120_000) * 2);
    for (let i = 1; i < ordered.length; i++) {
        const a = ordered[i - 1], b = ordered[i];
        if (a.value != null && b.value != null && b.time - a.time <= maxGap)
            differences.push(Math.abs(b.value - a.value));
    }
    return { p50, p95, samples: values.length, pairs: differences.length,
        variationMs: differences.length >= 5 ? differences.reduce((a, b) => a + b, 0) / differences.length : null };
}
function summarize(batches) {
    if (!batches.length)
        return null;
    const days = new Map();
    for (const batch of batches) {
        const day = new Date(batch.time + 8 * HOUR).toISOString().slice(0, 10);
        days.set(day, [...(days.get(day) || []), batch]);
    }
    const daily = [...days.values()];
    // 先按日汇总再跨日汇总，某天多次手工测试不会挤占其它日期的权重。
    return { score: median(daily.map(rows => median(rows.map(row => row.speed)))), days: days.size, runs: batches.length,
        download: median(daily.map(rows => median(rows.map(row => row.download.status === 'ok' ? row.download.mbps : 0)))),
        upload: median(daily.map(rows => median(rows.map(row => row.upload.status === 'ok' ? row.upload.mbps : 0)))) };
}
export function estimateNetwork(family, probes, results, now, offline) {
    const sourceProbe = probes.find(p => new RegExp(`(?:IP)?V${family === "ipv4" ? 4 : 6}(?:\\b|$)`, "i").test(p.taskName));
    const probe = sourceProbe ? recentProbe(sourceProbe, now) : undefined;
    const familyRows = results.filter(r => r.family === family && valid(r.tested_at) && r.tested_at <= now + 60_000);
    const latest = [...familyRows].sort((a, b) => b.tested_at - a.tested_at)[0];
    const batch = latest ? familyRows.filter(r => r.run_id === latest.run_id) : [];
    const download = batch.find(r => r.direction === "download"), upload = batch.find(r => r.direction === "upload");
    const metrics = probe ? probeVariation(probe, now) : null;
    const base = { modelVersion: 5, family, probe, testedAt: latest?.tested_at, download, upload, metrics,
        speedAgeMs: latest ? Math.max(0, now - latest.tested_at) : null, speedBasis: "latest",
        retransmission: null,
        latency: null, loss: null, speed: null, variation: null,
        latencyMs: null, peak: null, offpeak: null, peakWeight: 0, excludedBatches: 0, score: null };
    if (offline)
        return { ...base, reason: "节点离线" };
    if (!probe || probe.loadState === "error" || probe.loadState === "pending" || !valid(probe.loss) || probe.loss < 0 || probe.loss > 100 || (probe.lastValue == null && probe.loss < 100))
        return { ...base, reason: "探针数据不足" };
    if (!latest)
        return { ...base, reason: "暂无测速" };
    const age = now - latest.tested_at;
    if (age > 72 * HOUR)
        return { ...base, reason: "测速已过期" };
    if (!download || !upload)
        return { ...base, reason: "测速不完整" };
    if ([download, upload].some(r => r.status === "failed"))
        return { ...base, reason: "测速失败" };
    const validSpeed = (r) => r.status === "no_response" || (r.status === "ok" && valid(r.mbps) && r.mbps >= 0);
    if (![download, upload].every(validSpeed) || (probe.lastValue != null && (!valid(probe.lastValue) || probe.lastValue < 0)))
        return { ...base, reason: "指标无效" };
    const scoreSpeed = (d, u) => 0.7 * bandwidthScore(d.status === "ok" ? d.mbps : 0) + 0.3 * bandwidthScore(u.status === "ok" ? u.mbps : 0);
    const groups = new Map();
    for (const row of familyRows)
        groups.set(row.run_id, [...(groups.get(row.run_id) || []), row]);
    const batches = [];
    let excludedBatches = 0;
    for (const rows of groups.values()) {
        if (Math.max(...rows.map(r => r.tested_at)) < now - 72 * HOUR)
            continue;
        const d = rows.find(r => r.direction === "download"), u = rows.find(r => r.direction === "upload");
        if (d && u && validSpeed(d) && validSpeed(u))
            batches.push({ time: Math.min(d.tested_at, u.tested_at), download: d, upload: u, speed: scoreSpeed(d, u) });
        else
            excludedBatches++;
    }
    const peak = summarize(batches.filter(b => isPeakTime(b.time))), offpeak = summarize(batches.filter(b => !isPeakTime(b.time)));
    // 徽章回答当前状态：仅用时间最近一批，历史晚高峰只作参考，不混入当前分数。
    const peakWeight = 0;
    const speed = scoreSpeed(download, upload);
    const latencyMs = metrics && metrics.samples >= 3 && metrics.p95 != null && probe.lastValue != null ? 0.7 * probe.lastValue + 0.3 * metrics.p95 : probe.lastValue ?? 500;
    const latency = latencyScore(latencyMs), loss = failureScore(probe.loss);
    const variation = metrics?.variationMs != null ? variationScore(metrics.variationMs) : null;
    const total = 0.3 * latency + 0.2 * loss + 0.4 * speed + (variation == null ? 0 : 0.1 * variation);
    const rd = retransmissionCost(download), ru = retransmissionCost(upload);
    // 缺项不按零重传显示，也不额外奖分；仅对有依据的方向扣分，避免缺项放大惩罚。
    const retransmission = rd || ru ? { penalty: 0.7 * (rd?.penalty ?? 0) + 0.3 * (ru?.penalty ?? 0), download: rd, upload: ru } : null;
    const score = probe.loss === 100 ? 0 : Math.max(0, Math.round(total / (variation == null ? 0.9 : 1) - (retransmission?.penalty ?? 0)));
    const notes = [age > 6 * HOUR ? "带宽为较早实测参考" : age > HOUR ? "带宽非当前实测" : "", variation == null ? "近期波动样本不足" : ""].filter(Boolean);
    return { ...base, score, retransmission, latency, loss, speed, variation, latencyMs, peak, offpeak, peakWeight, excludedBatches,
        reason: notes.length ? `暂估 · ${notes.join(" · ")}` : "当前估算 v0.5" };
}
