<template>
  <div class="netwatch-admin">
    <p>持续探测由 deb 执行，结果与常规测速独立保存。限速结果用于验证低速异常，不替代峰值带宽。WAWO.HK 暂不加入。</p>
    <p v-if="message" role="status">{{ message }}</p>
    <div class="table-wrap"><table>
      <thead><tr><th>节点</th><th>范围</th><th>启用</th><th>每方向间隔</th><th>每日预算</th><th>今日载荷 / 预算预留</th><th>最近同步</th><th>操作</th></tr></thead>
      <tbody><tr v-for="node in nodes" :key="node.server_id">
        <td>{{ servers.find(s => s.id === node.server_id)?.name || node.server_id }}</td>
        <td :title="node.reason">{{ node.iperf_capable ? '双栈双向 + Ping/TCP' : 'Ping/TCP，测速受限' }}</td>
        <td><input type="checkbox" v-model="form(node).enabled" :aria-label="`${serverName(node.server_id)} 持续监测启用`" /></td>
        <td><select v-model.number="form(node).interval_seconds" :aria-label="`${serverName(node.server_id)} 持续探测间隔`"><option :value="120">2 分钟</option><option :value="300">5 分钟</option><option :value="600">10 分钟</option><option :value="900">15 分钟</option></select></td>
        <td><input type="number" min="16" max="10240" v-model.number="form(node).daily_budget_mib" :aria-label="`${serverName(node.server_id)} 每日预算 MiB`" /> MiB</td>
        <td>{{ ((node.payload_bytes || 0) / 1048576).toFixed(1) }} / {{ ((node.reserved_bytes || 0) / 1048576).toFixed(1) }} MiB <small>{{ node.budget_day }}</small></td>
        <td>{{ Date.now() - node.last_seen > 180000 ? '上报中断 · ' : '' }}{{ new Date(node.last_seen).toLocaleTimeString('zh-CN') }}</td>
        <td><button class="btn" :disabled="saving === node.server_id" @click="save(node)">保存持续监测</button></td>
      </tr></tbody>
    </table></div>
    <p v-if="!nodes.length">尚无 deb 持续探测上报。已部署的采集器同步后会显示；新节点默认不自动启用。</p>
    <small>后台更改约一分钟内生效；异常检测会在预算内加密。预算含控制裕量，不是运营商计费硬上限。节点详情 → 测速，可查看持续趋势与常规测速对照。</small>
  </div>
</template>
<script setup>
import { onBeforeUnmount, reactive, ref } from 'vue'
import { adminApi } from '../../../utils/api'
const props=defineProps({servers:{type:Array,default:()=>[]},selectedApiIndex:Number})
const nodes=ref([]),message=ref(''),saving=ref(null),forms=reactive({})
const serverName=id=>props.servers.find(s=>s.id===id)?.name||id
const form=node=>forms[node.server_id]||=( {enabled:!!node.enabled,interval_seconds:node.interval_seconds,daily_budget_mib:node.daily_budget_mib} )
let timer=null,disposed=false
async function load(){
  try{const response=await adminApi({action:'netwatch_list'},props.selectedApiIndex);if(response.error)throw Error(response.error);if(!disposed)nodes.value=response.data?.nodes||[]}
  catch(e){if(!disposed)message.value=e.message||'持续探测读取失败'}
  finally{if(!disposed)timer=setTimeout(load,15000)}
}
async function save(node){
  saving.value=node.server_id
  try{const response=await adminApi({action:'netwatch_configure',server_id:node.server_id,...form(node)},props.selectedApiIndex);if(response.error)throw Error(response.error);message.value='已保存，deb 下次同步时生效。'}
  catch(e){message.value=e.message||'保存失败'}
  finally{saving.value=null}
}
load()
onBeforeUnmount(()=>{disposed=true;clearTimeout(timer)})
</script>
<style scoped>
.netwatch-admin{margin:14px 0}.table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;min-width:900px}th,td{padding:10px;text-align:left;border-bottom:1px solid #7774}input[type=number]{width:80px}input,select{color:inherit;background:transparent;border:1px solid #7778;border-radius:4px;padding:5px}small{display:block;opacity:.7;line-height:1.6}
</style>
