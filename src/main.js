import { createApp } from 'vue'
import App from './App.vue'
import './style.css'

createApp(App).mount('#app')
const boot = document.getElementById('boot')
if (boot) boot.remove()