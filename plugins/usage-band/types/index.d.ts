export type Snap = {
  h5?: number
  h5Reset?: string
  wk?: number
  wkReset?: string
  ctxPct?: number
  ctxTok?: number
  ctxWin: number
  sub: boolean
  lastAt: number
  now: number
  /** Token level the reminder row reappears at after "Later"; 0 = threshold. */
  snooze?: number
  /** Toast already shown for this crossing. */
  warned?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'usage-band': { snap: Snap }
  }
}
