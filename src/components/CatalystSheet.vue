<script setup>
import { ref, watch, computed } from 'vue'
import BottomSheet from './BottomSheet.vue'
import { CATALYST_TYPES, setCatalyst, removeCatalyst, getCatalyst, isCatalystValid } from '../lib/catalysts'
import { closeCatalyst, toast } from '../lib/ui'

const props = defineProps({
  sector: { type: Object, default: null }
})

const type = ref('')
const note = ref('')

const current = computed(() => (props.sector ? getCatalyst(props.sector.key) : null))
const valid = computed(() => isCatalystValid(current.value))

watch(
  () => props.sector,
  (sector) => {
    if (!sector) return
    const entry = getCatalyst(sector.key)
    type.value = entry ? entry.type : ''
    note.value = entry ? entry.note : ''
  },
  { immediate: true }
)

function choose(key) {
  type.value = key
}

function save() {
  if (!props.sector || !type.value) return
  setCatalyst(props.sector.key, { type: type.value, note: note.value.trim() })
  if (type.value === 'rumor') {
    toast('已标记为纯传闻：按口诀直接排除', 'warn')
  } else if (type.value === 'none') {
    toast('已放入观察池，等催化出现', 'warn')
  } else {
    toast('催化已记录，请自行核实原始信源', 'success')
  }
  closeCatalyst()
}

function clear() {
  if (!props.sector) return
  removeCatalyst(props.sector.key)
  toast('已清除该板块的催化标记')
  closeCatalyst()
}
</script>

<template>
  <BottomSheet
    :open="!!sector"
    :title="sector ? `题材催化 · ${sector.name}` : '题材催化'"
    subtitle="自动行情无法判断新闻真伪，这一步必须人工核验"
    @close="closeCatalyst"
  >
    <template v-if="sector">
      <div class="cat-status">
        <span class="chip" :class="valid ? 'chip--green' : current ? 'chip--warn' : 'chip--dim'">
          {{ valid ? '催化有效' : current ? '非有效催化' : '尚未核验' }}
        </span>
        <span class="dim">
          热度 {{ sector.heat }} · 今日 {{ sector.todayCount }} 家涨停
        </span>
      </div>

      <div class="cat-grid">
        <button
          v-for="option in CATALYST_TYPES"
          :key="option.key"
          class="cat-option"
          :class="{
            'is-active': type === option.key,
            'is-danger': option.key === 'rumor'
          }"
          @click="choose(option.key)"
        >
          <span class="cat-radio"></span>
          <span class="cat-copy">
            <b>{{ option.label }}</b>
            <p>{{ option.desc }}</p>
          </span>
        </button>
      </div>

      <label class="note-label" for="catalyst-note">信源备注（只保存在本机）</label>
      <textarea
        id="catalyst-note"
        v-model="note"
        class="note-input"
        placeholder="例如：工信部 11/20 发布 XX 产业规划；龙头公司公告中标 XX 项目…"
      ></textarea>

      <p class="cat-tip">
        题材纯正不蹭风：只做有政策 / 产业 / 事件证据的方向。纯传闻、无信源小作文、一天脉冲，按纪律直接排除；
        拿不准就选「暂无催化」放观察池，不要用想象替代证据。
      </p>

      <div class="sheet-actions">
        <button v-if="current" class="btn btn--danger" @click="clear">清除标记</button>
        <button class="btn btn--gold" :disabled="!type" @click="save">保存核验结果</button>
      </div>
    </template>
  </BottomSheet>
</template>

<style scoped>
.cat-status {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  font-size: 12px;
}
</style>