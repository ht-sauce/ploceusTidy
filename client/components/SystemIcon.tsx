/**
 * 系统风格图标：全部用 24×24 viewBox 内联 SVG，保持与资源管理器相近的配色。
 * 不引入图标字体或远程资源，避免启动时额外请求。
 */
import type { SystemIconKind } from '@/types/scene'

interface SystemIconProps {
  kind: SystemIconKind
  size?: number
  className?: string
}

const page = (
  <>
    <path
      d="M5.2 2.6h8.9l4.7 4.7v13.4a.9.9 0 0 1-.9.9H5.2a.9.9 0 0 1-.9-.9V3.5a.9.9 0 0 1 .9-.9Z"
      fill="#fff"
      stroke="#d9d9d6"
      strokeWidth=".8"
    />
    <path d="M14.1 2.6v4.7h4.7" fill="#ededea" />
  </>
)

export default function SystemIcon({ kind, size = 22, className }: SystemIconProps) {
  const props = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    // 画布会把图标序列化成 data URL 交给 Image 解码，缺少 xmlns 时浏览器直接判为无效 SVG。
    xmlns: 'http://www.w3.org/2000/svg',
    className,
    'aria-hidden': true,
    focusable: false,
  } as const

  if (kind === 'folder') {
    return (
      <svg {...props}>
        <path
          d="M2.7 7.2a2.1 2.1 0 0 1 2.1-2.1h4.1l2 2h8.3a2.1 2.1 0 0 1 2.1 2.1v8.6a2.1 2.1 0 0 1-2.1 2.1H4.8a2.1 2.1 0 0 1-2.1-2.1Z"
          fill="#f4c84b"
        />
        <path
          d="M2.7 9.9h18.6v8.4a2.1 2.1 0 0 1-2.1 2.1H4.8a2.1 2.1 0 0 1-2.1-2.1Z"
          fill="#e2ae31"
          opacity=".35"
        />
      </svg>
    )
  }

  if (kind === 'pdf') {
    return (
      <svg {...props}>
        {page}
        <rect x="7" y="11.6" width="10" height="5.7" rx="1" fill="#c94a43" />
        <text
          x="12"
          y="15.8"
          textAnchor="middle"
          fontSize="4.2"
          fontWeight="700"
          fill="#fff"
          fontFamily="Segoe UI, sans-serif"
        >
          PDF
        </text>
      </svg>
    )
  }

  if (kind === 'docx') {
    return (
      <svg {...props}>
        {page}
        <rect x="7" y="11.6" width="10" height="5.7" rx="1" fill="#2b5b9e" />
        <text
          x="12"
          y="15.9"
          textAnchor="middle"
          fontSize="4.8"
          fontWeight="700"
          fill="#fff"
          fontFamily="Segoe UI, sans-serif"
        >
          W
        </text>
      </svg>
    )
  }

  if (kind === 'xlsx') {
    return (
      <svg {...props}>
        {page}
        <rect x="7" y="11.6" width="10" height="5.7" rx="1" fill="#2f7d4a" />
        <text
          x="12"
          y="15.9"
          textAnchor="middle"
          fontSize="4.8"
          fontWeight="700"
          fill="#fff"
          fontFamily="Segoe UI, sans-serif"
        >
          X
        </text>
      </svg>
    )
  }

  if (kind === 'dwg') {
    return (
      <svg {...props}>
        {page}
        <rect x="7" y="11.6" width="10" height="5.7" rx="1" fill="#315e8a" />
        <text
          x="12"
          y="15.7"
          textAnchor="middle"
          fontSize="3.6"
          fontWeight="700"
          fill="#fff"
          fontFamily="Segoe UI, sans-serif"
        >
          DWG
        </text>
      </svg>
    )
  }

  if (kind === 'txt') {
    return (
      <svg {...props}>
        {page}
        <path
          d="M8 12h8M8 14.2h8M8 16.4h5.5"
          stroke="#8e8e88"
          strokeWidth="1.1"
          strokeLinecap="round"
        />
      </svg>
    )
  }

  if (kind === 'exe') {
    return (
      <svg {...props}>
        <rect x="3.2" y="4.2" width="17.6" height="15.6" rx="2.4" fill="#e7ecf1" stroke="#b9c5d1" />
        <path d="M3.2 7h17.6v2.4H3.2Z" fill="#52799d" />
        <path d="M6.2 12h4.6M6.2 15h7.5" stroke="#687b8c" strokeWidth="1.2" strokeLinecap="round" />
        <circle cx="5.5" cy="5.7" r=".65" fill="#fff" opacity=".8" />
      </svg>
    )
  }

  if (kind === 'image') {
    return (
      <svg {...props}>
        <rect x="3" y="4" width="18" height="16" rx="2" fill="#e8f0ea" stroke="#b9cbbf" />
        <circle cx="8.4" cy="9" r="1.8" fill="#e6b95c" />
        <path
          d="m4.2 17 4.5-5.1 3 3 2.5-2.8 4.6 4.9"
          fill="none"
          stroke="#6e927c"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
    )
  }

  if (kind === 'video') {
    return (
      <svg {...props}>
        <rect x="3" y="5" width="18" height="14" rx="2" fill="#e9edf0" stroke="#bcc5ca" />
        <path d="M10 9.2 15 12l-5 2.8Z" fill="#5f7180" />
      </svg>
    )
  }

  if (kind === 'link') {
    return (
      <svg {...props}>
        <path
          d="M9.6 13.8a3.6 3.6 0 0 0 5.1 0l2.2-2.2a3.6 3.6 0 0 0-5.1-5.1l-1.2 1.2"
          fill="none"
          stroke="#3f7fbf"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        <path
          d="M14.4 10.2a3.6 3.6 0 0 0-5.1 0l-2.2 2.2a3.6 3.6 0 0 0 5.1 5.1l1.2-1.2"
          fill="none"
          stroke="#3f7fbf"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    )
  }

  return (
    <svg {...props}>
      {page}
      <path
        d="M8 12h8M8 14.2h8M8 16.4h5.5"
        stroke="#8e8e88"
        strokeWidth="1.1"
        strokeLinecap="round"
      />
    </svg>
  )
}
