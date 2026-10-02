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
  /** Cache TTL proven by a hit or miss after an idle gap; unset = guess from plan. */
  ttl?: '5m' | '1h'
  /** Model of the last response; a switch starts a fresh cache. */
  model?: string
  /** Share of the last turn's prompt read from cache (first response of the turn). */
  hit?: number
  /** Tokens the last turn paid in full because the cache missed. */
  missTok?: number
  /** When the limits shown were reported; newer ones saved by any session replace them. */
  limitsAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    'usage-band': { snap: Snap }
  }
}
