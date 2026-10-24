/** 前端入口：主题与 Ant Design 容器由 `App` 统一提供。 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'antd/dist/reset.css'
import App from './App'
import './styles/global.css'

const rootElement = document.getElementById('app')

if (!rootElement) {
  throw new Error('Missing #app root element')
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
