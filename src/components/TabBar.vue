<script setup>
defineProps({
  modelValue: { type: String, default: 'mainline' }
})
defineEmits(['update:modelValue'])

const tabs = [
  {
    key: 'mainline',
    label: '主线',
    icon: 'M12 3a9 9 0 1 0 9 9M12 7a5 5 0 1 1-5 5M12 11a1 1 0 1 0 0 2 1 1 0 0 0 0-2M21 3l-6.5 6.5M17.5 3H21v3.5'
  },
  {
    key: 'picks',
    label: '选票',
    icon: 'M12 3v3M12 18v3M3 12h3M18 12h3M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8M12 11.2a.8.8 0 1 0 0 1.6.8.8 0 0 0 0-1.6'
  },
  {
    key: 'edge',
    label: '竞价',
    icon: 'M13 2 4.5 13.5H11l-1 8.5 9-12h-6.5L13 2Z'
  },
  {
    key: 'review',
    label: '复盘',
    icon: 'M4 20V10M9.3 20V5M14.7 20v-7M20 20V8'
  },
  {
    key: 'strategy',
    label: '战法',
    icon: 'M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4ZM19 20a3 3 0 0 1-3-3V4M9 8h6M9 12h6'
  }
]
</script>

<template>
  <nav class="tabbar" aria-label="主导航">
    <div class="tabbar-inner">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        class="tab"
        :class="{ 'is-active': modelValue === tab.key }"
        :aria-current="modelValue === tab.key ? 'page' : undefined"
        @click="$emit('update:modelValue', tab.key)"
      >
        <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
          <path :d="tab.icon" />
        </svg>
        <span>{{ tab.label }}</span>
      </button>
    </div>
  </nav>
</template>