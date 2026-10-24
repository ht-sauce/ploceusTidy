/** 前端入口：挂载 Ant Design ConfigProvider 与全局提示容器。 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App as AntApp, ConfigProvider, theme } from 'antd'
import 'antd/dist/reset.css'
import App from './App'
import './styles/global.css'

const rootElement = document.getElementById('app')

if (!rootElement) {
  throw new Error('Missing #app root element')
}

createRoot(rootElement).render(
  <StrictMode>
    <ConfigProvider
      componentSize="small"
      theme={{
        algorithm: theme.compactAlgorithm,
        token: {
          colorPrimary: '#2f6b5b',
          borderRadius: 6,
          fontFamily: '"Segoe UI", "Microsoft YaHei", system-ui, sans-serif',
        },
      }}
    >
      <AntApp>
        <App />
      </AntApp>
    </ConfigProvider>
  </StrictMode>,
)
