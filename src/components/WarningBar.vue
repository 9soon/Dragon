<script setup>
import { computed, ref } from 'vue'

const props = defineProps({
  items: { type: Array, default: () => [] }
})

const open = ref(false)
const count = computed(() => props.items.length)
const first = computed(() => props.items[0] || '')
</script>

<template>
  <div v-if="count" class="warning-bar" :class="{ 'is-open': open }">
    <button class="warning-main" @click="open = !open">
      <span class="ico">!</span>
      <span class="txt">{{ count > 1 ? '数据源部分降级' : first }}</span>
      <span class="dim">{{ count > 1 ? `${count} 项` : '' }}</span>
      <span class="chev">▾</span>
    </button>
    <div v-if="open" class="warning-list">
      <div v-for="(item, idx) in items" :key="idx">{{ item }}</div>
    </div>
  </div>
</template>