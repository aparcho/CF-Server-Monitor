<template>
  <div v-if="activeTab === 'iperf'" class="tab-content active iperf-panel">
    <h3>iperf3 测速</h3>
    <p>测试由 deb 发起，使用目标节点的临时 5202 监听。每天可设置日间、晚高峰及可选的第二次晚高峰测试，时间均为北京时间。</p>
    <p>新 Linux 节点使用后台安装命令并以 root 安装时会自动接入测速。接入检查通过后可手动测速，定时默认关闭。</p>
    <button class="btn" :disabled="loading" @click="load">↻ 刷新任务</button>
    <p v-if="message" :class="{ 'iperf-error': error }">{{ message }}</p>
    <div class="iperf-table-wrap">
      <table class="iperf-table">
        <thead><tr><th>节点</th><th>测试时长</th><th>手动触发</th><th>每天定时</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="server in servers" :key="server.id">
            <td>{{ server.name || server.id }}
              <div v-if="enrollment(server.id)" class="iperf-enrollment">
                {{ enrollmentName(server.id) }}
                <span v-if="enrollment(server.id).error">：{{ enrollment(server.id).error }}</span>
                <button v-if="enrollment(server.id).status === 'blocked'" class="btn" :disabled="loading || pending(server.id)" @click="retry(server.id)">重新检查</button>
              </div>
            </td>
            <td><select v-model.number="form(server.id).duration_seconds"><option :value="5">5 秒</option><option :value="10">10 秒</option><option :value="30">30 秒</option></select></td>
            <td><button class="btn" :disabled="loading || pending(server.id) || !ready(server.id)" @click="trigger(server.id)">{{ !ready(server.id) ? '未接入 deb' : pending(server.id) ? '任务进行中' : '开始测速' }}</button></td>
            <td><div class="iperf-schedule">
              <label><input type="checkbox" v-model="form(server.id).enabled" /> 启用每日定时</label>
              <label>日间 <input type="time" v-model="form(server.id).time_beijing_day" :aria-label="`${server.name || server.id} 日间时间（北京时间）`" /></label>
              <label>晚高峰 <input type="time" v-model="form(server.id).time_beijing" :aria-label="`${server.name || server.id} 晚高峰时间（北京时间）`" /></label>
              <label>晚高峰 2（可选） <input type="time" v-model="form(server.id).time_beijing_extra" :aria-label="`${server.name || server.id} 第二次晚高峰时间（北京时间）`" /></label>
              <button v-if="form(server.id).time_beijing_extra" class="btn" @click="form(server.id).time_beijing_extra = ''">清除第三次</button>
            </div></td>
            <td><button class="btn" :disabled="loading || (form(server.id).enabled && !ready(server.id))" @click="save(server.id)">保存定时</button></td>
          </tr>
        </tbody>
      </table>
    </div>
    <details class="netwatch-settings"><summary>持续探测设置与上报状态</summary>
      <NetwatchPanel :servers="servers" :selected-api-index="selectedApiIndex" />
    </details>
    <h4>最近任务</h4>
    <p class="iperf-result-hint">下载、上传均以 deb 为视角；单位 Mbps，括号内为 TCP 重传次数。</p>
    <div class="iperf-table-wrap"><table class="iperf-table"><thead><tr><th>节点</th><th>来源</th><th>状态</th><th>创建时间</th><th>结果</th></tr></thead>
      <tbody><tr v-for="job in jobs" :key="job.id">
        <td>{{ serverName(job.server_id) }}</td>
        <td>{{ job.source === 'onboarding' ? '自动接入检查' : job.source === 'scheduled' ? '定时' : '手动' }}</td>
        <td class="iperf-job-status">{{ statusName(job.status) }}</td>
        <td class="iperf-job-time">{{ formatTime(job.created_at) }}</td>
        <td class="iperf-job-results">
          <div v-for="family in resultFamilies(job)" :key="family.key" class="iperf-result-family">
            <span class="iperf-family-label">{{ family.label }}</span>
            <span :title="resultTitle(job, family.key, 'download')">↓ {{ resultValue(job, family.key, 'download') }}</span>
            <span :title="resultTitle(job, family.key, 'upload')">↑ {{ resultValue(job, family.key, 'upload') }}</span>
          </div>
          <div v-if="job.status === 'failed'" class="iperf-error iperf-job-error">{{ job.error || '失败' }}</div>
          <template v-else-if="!job.results?.length">{{ job.source === 'onboarding' && job.status === 'completed' ? '公网检查通过' : job.result_count != null ? `${job.result_count} 项结果 · 暂无明细` : '—' }}</template>
        </td>
      </tr></tbody>
    </table></div>
  </div>
</template>

<script setup>
import { onBeforeUnmount, reactive, ref, watch } from 'vue'
import NetwatchPanel from './NetwatchPanel.vue'
import { adminApi } from '../../../utils/api'

const props = defineProps({ activeTab: String, servers: { type: Array, default: () => [] }, selectedApiIndex: Number })
const jobs = ref([])
const readyTargets = ref([])
const enrollments = ref([])
const enrollment = (id) => enrollments.value.find(row => row.server_id === id)
const enrollmentName = (id) => {
  const row = enrollment(id)
  if (Date.now() - row.last_seen > 5 * 60_000) return '测速助手离线'
  return { pending: '自动接入检查中', ready: '已自动接入', blocked: '自动接入待处理' }[row.status]
}
const forms = reactive({})
const loading = ref(false)
const message = ref('')
const error = ref(false)
const form = (id) => forms[id] ||= { enabled: false, time_beijing_day: '11:30', time_beijing: '21:30', time_beijing_extra: '', duration_seconds: 10 }
const serverName = (id) => props.servers.find(s => s.id === id)?.name || id
const pending = (id) => jobs.value.some(j => j.server_id === id && ['queued', 'running'].includes(j.status))
const ready = (id) => readyTargets.value.includes(id)
const statusName = (status) => ({ queued: '等待执行', running: '测速中', completed: '已完成', failed: '失败' })[status] || status
const formatTime = (ms) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium' }).format(new Date(ms))
const resultFamilies = (job) => [{ key: 'ipv4', label: 'IPv4' }, { key: 'ipv6', label: 'IPv6' }].filter(family => job.results?.some(row => row.family === family.key))
const resultRow = (job, family, direction) => job.results?.find(row => row.family === family && row.direction === direction)
const resultValue = (job, family, direction) => {
  const row = resultRow(job, family, direction)
  if (!row) return '—'
  if (row.status !== 'ok') return row.status === 'no_response' ? '无响应' : '失败'
  if (row.mbps == null || !Number.isFinite(Number(row.mbps))) return '—'
  return `${Number(row.mbps).toFixed(2)}（${row.retransmits ?? '—'}）`
}
const resultTitle = (job, family, direction) => {
  const row = resultRow(job, family, direction)
  return row?.error || (row?.status === 'ok' ? `${Number(row.mbps).toFixed(2)} Mbps，TCP 重传 ${row.retransmits ?? '—'} 次` : '')
}
let pollTimer = null
let listRequests = 0
let loadSequence = 0
let disposed = false
const stopPolling = () => { clearTimeout(pollTimer); pollTimer = null }
const schedulePolling = () => {
  stopPolling()
  if (disposed || props.activeTab !== 'iperf' || !jobs.value.some(job => ['queued', 'running'].includes(job.status))) return
  pollTimer = setTimeout(() => {
    pollTimer = null
    if (loading.value || listRequests) schedulePolling()
    else load({ background: true })
  }, 5000)
}
async function call(data, background = false) {
  if (!background) { loading.value = true; message.value = '' }
  try {
    const response = await adminApi(data, props.selectedApiIndex)
    if (response.error) throw new Error(response.error)
    if (!background) error.value = false
    return response.data
  } catch (cause) {
    if (!background) { error.value = true; message.value = cause.message || '请求失败' }
    return null
  } finally { if (!background) loading.value = false }
}
async function load(options = {}) {
  const background = options.background === true
  const sequence = ++loadSequence
  stopPolling()
  listRequests++
  try {
    const data = await call({ action: 'iperf_list' }, background)
    if (!data || disposed || sequence !== loadSequence || props.activeTab !== 'iperf') return
    jobs.value = data.jobs || []
    readyTargets.value = data.ready_targets || []
    enrollments.value = data.enrollments || []
    // 自动刷新只更新任务；保留用户尚未保存的定时与时长编辑。
    if (!background) for (const schedule of data.schedules || []) Object.assign(form(schedule.server_id), { enabled: !!schedule.enabled, time_beijing: schedule.time_beijing, time_beijing_day: schedule.time_beijing_day || '11:30', time_beijing_extra: schedule.time_beijing_extra || '', duration_seconds: schedule.duration_seconds })
  } finally { listRequests--; schedulePolling() }
}
async function trigger(id) {
  const data = await call({ action: 'iperf_trigger', server_id: id, duration_seconds: form(id).duration_seconds })
  if (data) {
    jobs.value = [{ id: data.id, server_id: id, source: 'manual', status: 'queued', created_at: Date.now() }, ...jobs.value]
    message.value = '任务已排队，deb 将在下一次轮询时执行。'
    await load()
  }
}
async function retry(id) {
  if (await call({ action: 'iperf_onboard_retry', server_id: id })) await load()
}
async function save(id) {
  const times = [form(id).time_beijing_day, form(id).time_beijing, form(id).time_beijing_extra].filter(Boolean)
  if (new Set(times).size !== times.length || !form(id).time_beijing_day || !form(id).time_beijing || form(id).time_beijing_day === form(id).time_beijing) {
    error.value = true
    message.value = '请设置不同的测试时间。'
    return
  }
  const data = await call({ action: 'iperf_schedule', server_id: id, ...form(id) })
  if (data) message.value = `定时配置已保存：每天 ${[data.time_beijing_day, data.time_beijing, data.time_beijing_extra].filter(Boolean).sort().join('、')}（北京时间）。`
}
watch(() => [props.activeTab, props.selectedApiIndex], ([tab]) => {
  ++loadSequence
  stopPolling()
  if (tab === 'iperf') load()
}, { immediate: true })
onBeforeUnmount(() => { disposed = true; ++loadSequence; stopPolling() })
</script>

<style scoped>
.iperf-panel { padding: 20px; }
.iperf-panel p { margin: 12px 0; }
.iperf-error { color: #e55; }
.iperf-enrollment { max-width: 260px; margin-top: 6px; font-size: 12px; opacity: .8; }
.iperf-table-wrap { overflow-x: auto; margin: 16px 0; }
.iperf-table { width: 100%; border-collapse: collapse; min-width: 620px; }
.iperf-table th, .iperf-table td { padding: 10px; border-bottom: 1px solid #7774; text-align: left; }
.iperf-schedule { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; }
.iperf-schedule label { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.iperf-table input[type=time], .iperf-table select { color: inherit; background: transparent; border: 1px solid #7778; border-radius: 4px; padding: 5px; }
.iperf-job-status, .iperf-job-time { white-space: nowrap; }
.iperf-job-results { min-width: 380px; font-variant-numeric: tabular-nums; }
.iperf-result-family { display: grid; grid-template-columns: 44px minmax(145px, 1fr) minmax(145px, 1fr); gap: 8px; line-height: 1.7; white-space: nowrap; }
.iperf-family-label, .iperf-result-hint { opacity: .7; }
.iperf-result-hint { font-size: 12px; }
.iperf-job-error { margin-top: 4px; overflow-wrap: anywhere; }
</style>
