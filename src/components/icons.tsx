import type { ReactNode } from 'react'

/*
 * 内联 SVG 图标：不引入图标依赖，也不使用 emoji 充当界面图标。
 * 所有图标都用 currentColor 描边，跟随所在按钮的文字颜色。
 */

const strokeProps = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const

function Icon({ size = 16, children }: { size?: number; children: ReactNode }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...strokeProps}>{children}</svg>
}

export function EyeIcon({ size }: { size?: number }) {
  return <Icon size={size}><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z" /><circle cx="12" cy="12" r="3" /></Icon>
}

export function BoltIcon({ size }: { size?: number }) {
  return <Icon size={size}><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" fill="currentColor" stroke="none" /></Icon>
}

export function GearIcon({ size }: { size?: number }) {
  return <Icon size={size}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1h.2a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.6 1z" /></Icon>
}

export function LockIcon({ size }: { size?: number }) {
  return <Icon size={size}><rect x="3" y="11" width="18" height="11" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></Icon>
}

export function CheckIcon({ size }: { size?: number }) {
  return <Icon size={size}><path d="M20 6 9 17l-5-5" /></Icon>
}

export function AlertIcon({ size }: { size?: number }) {
  return <Icon size={size}><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4" /><path d="M12 17h.01" /></Icon>
}

export function CloseIcon({ size }: { size?: number }) {
  return <Icon size={size}><path d="M18 6 6 18" /><path d="M6 6l12 12" /></Icon>
}
