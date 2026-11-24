import { reactive } from 'vue'

export const ui = reactive({
  catalystSector: null,
  pick: null,
  warningsOpen: false,
  toast: null,
  alertFocus: ''
})

let toastTimer = null

export function openCatalyst(sector) {
  ui.catalystSector = sector
}

export function closeCatalyst() {
  ui.catalystSector = null
}

export function openPick(pick) {
  ui.pick = pick
}

export function closePick() {
  ui.pick = null
}

export function openWarnings() {
  ui.warningsOpen = true
}

export function closeWarnings() {
  ui.warningsOpen = false
}

export function toast(message, tone = 'default') {
  ui.toast = { message, tone, at: Date.now() }
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    ui.toast = null
  }, 2400)
}