import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'element-plus/dist/index.css'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'
import App from '@/App.vue'
import router from '@/router'
import { ensureSeeded, stampDbVersion } from '@/utils/db'
import { useReconcileStore } from '@/stores/reconcileStore'
import '@/styles/main.css'

const app = createApp(App)

Object.entries(ElementPlusIconsVue).forEach(([key, component]) => {
  app.component(key, component)
})

const pinia = createPinia()
app.use(pinia)
app.use(router)
app.use(ElementPlus, { locale: zhCn })

stampDbVersion()

// 首次进入自动播种演示数据（幂等：机组表非空时不做任何写入），完成后再挂载，避免首屏空白。
// 挂载前恢复「写入中」的外委批次：保留进度，从断点继续写入并完成对账。
ensureSeeded()
  .finally(async () => {
    try {
      await useReconcileStore(pinia).resumeInterrupted()
    } catch (error) {
      console.error('[gbwindblade] 恢复外委批次失败：', error)
    }
  })
  .finally(() => {
    app.mount('#app')
  })
