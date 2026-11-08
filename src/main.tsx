import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from '@/App.tsx'
import '@/index.css'
import { registerSW } from 'virtual:pwa-register'

// App instalado na tela inicial: baixa a versão nova sozinho e recarrega,
// em vez de continuar com a antiga até ser aberto duas vezes.
registerSW({
  immediate: true,
  onRegisteredSW(_url, registration) {
    if (!registration) return
    const check = () => {
      if (document.visibilityState === 'visible') void registration.update()
    }
    setInterval(check, 30 * 60 * 1000)
    document.addEventListener('visibilitychange', check)
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
