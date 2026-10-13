<template>
  <div v-if="activeTab === 'iperf'" class="tab-content active iperf-panel">
    <h3>iperf3 测速</h3>
    <p>测试由 deb 发起，使用目标节点的临时 5202 监听。定时任务默认关闭，时间均为北京时间。</p>
    <button class="btn" :disabled="loading" @click="load">↻ 刷新任务</button>
    <p v-if="message" :class="{ 'iperf-error': error }">{{ message }}</p>
    <div class="iperf-table-wrap">
      <table class="iperf-table">
        <thead><tr><th>节点</th><th>测试时长</th><th>手动触发</th><th>每天定时</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="server in servers" :key="server.id">
            <td>{{ server.name || server.id }}</td>
            <td><select v-model.number="form(server.id).duration_seconds"><option :value="10">10 秒</option><option :value="30">30 秒</option></select></td>
            <td><button class="btn" :disabled="loading || pending(server.id)" @click="trigger(server.id)">{{ pending(server.id) ? '任务进行中' : '开始测速' }}</button></td>
            <td><label><input type="checkbox" v-model="form(server.id).enabled" /> 启用</label> <input type="time" v-model="form(server.id).time_beijing" /></td>
            <td><button class="btn" :disabled="loading" @click="save(server.id)">保存定时</button></td>
          </tr>
        </tbody>
      </table>
    </div>
    <h4>最近任务</h4>
    <div class="iperf-table-wrap"><table class="iperf-table"><thead><tr><th>节点</th><th>来源</th><th>状态</th><th>创建时间</th><th>结果</th></tr></thead>
      <tbody><tr v-for="job in jobs" :key="job.id"><td>{{ serverName(job.server_id) }}</td><td>{{ job.source === 'scheduled' ? '定时' : '手动' }}</td><td>{{ statusName(job.status) }}</td><td>{{ formatTime(job.created_at) }}</td><td>{{ job.status === 'failed' ? (job.error || '失败') : (job.result_count ?? '—') }}</td></tr></tbody>
    </table></div>
  </div>
</template>

<script setup>
import { reactive, ref, watch } from 'vue'
import { adminApi } from '../../../utils/api'

const props = defineProps({ activeTab: String, servers: { type: Array, default: () => [] }, selectedApiIndex: Number })
const jobs = ref([])
const forms = reactive({})
const loading = ref(false)
const message = ref('')
const error = ref(false)
const form = (id) => forms[id] ||= { enabled: false, time_beijing: '03:00', duration_seconds: 10 }
const serverName = (id) => props.servers.find(s => s.id === id)?.name || id
const pending = (id) => jobs.value.some(j => j.server_id === id && ['queued', 'running'].includes(j.status))
const statusName = (status) => ({ queued: '等待执行', running: '测速中', completed: '已完成', failed: '失败' })[status] || status
const formatTime = (ms) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium' }).format(new Date(ms))
async function call(data) {
  loading.value = true
  message.value = ''
  try {
    const response = await adminApi(data, props.selectedApiIndex)
    if (response.error) throw new Error(response.error)
    error.value = false
    return response.data
  } catch (cause) {
    error.value = true
    message.value = cause.message || '请求失败'
    return null
  } finally { loading.value = false }
}
async function load() {
  const data = await call({ action: 'iperf_list' })
  if (!data) return
  jobs.value = data.jobs || []
  for (const schedule of data.schedules || []) Object.assign(form(schedule.server_id), { enabled: !!schedule.enabled, time_beijing: schedule.time_beijing, duration_seconds: schedule.duration_seconds })
}
async function trigger(id) {
  const data = await call({ action: 'iperf_trigger', server_id: id, duration_seconds: form(id).duration_seconds })
  if (data) { message.value = '任务已排队，deb 将在下一次轮询时执行。'; await load() }
}
async function save(id) {
  const data = await call({ action: 'iperf_schedule', server_id: id, ...form(id) })
  if (data) message.value = '定时配置已保存。'
}
watch(() => [props.activeTab, props.selectedApiIndex], ([tab]) => { if (tab === 'iperf') load() })
</script>

<style scoped>
.iperf-panel { padding: 20px; }
.iperf-panel p { margin: 12px 0; }
.iperf-error { color: #e55; }
.iperf-table-wrap { overflow-x: auto; margin: 16px 0; }
.iperf-table { width: 100%; border-collapse: collapse; min-width: 620px; }
.iperf-table th, .iperf-table td { padding: 10px; border-bottom: 1px solid #7774; text-align: left; }
.iperf-table input[type=time], .iperf-table select { color: inherit; background: transparent; border: 1px solid #7778; border-radius: 4px; padding: 5px; }
</style>
