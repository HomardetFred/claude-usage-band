import { atom, read, update } from 'claude-code'
import type { Register, SessionUsage } from 'claude-code'

import type { Snap } from '../types'

// Prompt-cache TTL guess: subscriptions (rate limits reported) get 1h, API keys 5m.
const TTL_SUB = 60 * 60_000
const TTL_API = 5 * 60_000
// Past this many context tokens, nudge toward /compact or /clear.
const NAG = 400_000
const NAG_HARD = 600_000

const snap = atom({ plugin: 'usage-band', key: 'snap' } as const, {
  ctxWin: 0, sub: false, lastAt: 0, now: 0,
} as Snap)

const k = (n: number) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`)

const left = (ms: number) => {
  const m = Math.max(0, Math.ceil(ms / 60_000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`
}

const OK = '#4caf6a', WARN = '#d9a53a', BAD = '#e5534b', WARMC = '#e8823a', COOL = '#5aa9e6'
const tone = (p: number) => (p >= 90 ? BAD : p >= 70 ? WARN : OK)

type Cell = { icon: string; value: string; sub: string; frac: number; color: string; hot?: boolean }


// Glyphs drawn inside each ring, centred on (12,14); stroked/filled in the ring's colour.
const ICONS: Record<string, (c: string) => string> = {
  ctx: c => `<path d="M8.6 11h6.8M8.6 14h6.8M8.6 17h4.2" stroke="${c}" stroke-width="1.5" stroke-linecap="round" fill="none"/>`,
  clock: c => `<path d="M12 10.4V14l2.5 1.6" stroke="${c}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`,
  cal: c => `<g stroke="${c}" stroke-width="1.3" fill="none" stroke-linecap="round"><rect x="8.4" y="10.6" width="7.2" height="6.6" rx="1.2"/><path d="M10.2 9.4v2M13.8 9.4v2M8.4 13h7.2"/></g>`,
  flame: c => `<path d="M12 9.2c1.7 1.9 3 3.4 3 5.3a3 3 0 0 1-6 0c0-1.2.6-2.1 1.4-2.8.1.9.5 1.5 1.1 1.7-.3-1.4 0-2.8.5-4.2z" fill="${c}"/>`,
  snow: c => `<path d="M12 10v8M8.55 12l6.9 4M8.55 16l6.9-4" stroke="${c}" stroke-width="1.4" stroke-linecap="round"/>`,
}

// Just the ring + glyph; the text beside it is laid out by the app itself.
const gauge = (c: Cell) => {
  const R = 10.5, C = 2 * Math.PI * R, f = Math.max(0, Math.min(1, c.frac))
  return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28">
<style>.t{fill:none;stroke:#000;stroke-opacity:.12;stroke-width:2}@media (prefers-color-scheme:dark){.t{stroke:#fff;stroke-opacity:.16}}</style>
<circle cx="12" cy="14" r="${R}" class="t"/>
${f ? `<circle cx="12" cy="14" r="${R}" fill="none" stroke="${c.color}" stroke-width="2" stroke-linecap="round" stroke-dasharray="${(f * C).toFixed(2)} ${C.toFixed(2)}" transform="rotate(-90 12 14)"/>` : ''}
${ICONS[c.icon](c.color)}</svg>`
}

const ring = (f: number) => '○◔◑◕●'[Math.round(Math.max(0, Math.min(1, f)) * 4)]

const fold = (u: Pick<SessionUsage, 'context' | 'rateLimits'>) => (s: Snap): Snap => {
  const h5 = u.rateLimits.find(r => r.kind === 'five_hour')
  const wk = u.rateLimits.find(r => r.kind === 'seven_day')
  return {
    ...s,
    h5: h5?.percentUsed, h5Reset: h5?.resetsAt,
    wk: wk?.percentUsed, wkReset: wk?.resetsAt,
    ctxPct: u.context.percent, ctxTok: u.context.tokens, ctxWin: u.context.window,
    sub: u.rateLimits.length > 0,
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const now = await $.clock.now()
    const ago = e.seconds_since_last_response
    const u = await $.session.usage()
    await update($, snap, s => ({
      ...fold(u)(s),
      now,
      lastAt: e.source === 'clear' ? 0 : ago === undefined ? s.lastAt : now - ago * 1000,
    }))
    // One redraw a minute keeps the countdowns honest; no model calls, no tokens.
    $.clock.every(60_000, async () => {
      const t = await $.clock.now()
      await update($, snap, s => ({ ...s, now: t }))
    })
    return next(e)
  })

  // Pushed by the engine after each response / when a limit moves a point: no polling.
  on('session.measure', async ($, e, next) => {
    const now = await $.clock.now()
    const isResponse = e.changed.includes('context')
    const tok = e.context.tokens ?? 0
    const prev = await read($, snap)
    if (tok >= NAG && !prev.warned) {
      $.ui.toast(`Context is at ${k(tok)} tokens: every turn re-sends all of it. Consider compacting or clearing.`)
    }
    await update($, snap, s => ({
      ...fold(e)(s), now, lastAt: isResponse ? now : s.lastAt,
      warned: tok >= NAG,
      snooze: tok < NAG ? 0 : s.snooze,
    }))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, snap, s => ({ ...s, lastAt: now, now }))
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const s = await read($, snap)
    const now = Math.max(s.now, s.lastAt)
    const until = (iso?: string) => (iso ? `resets ${left(Date.parse(iso) - now).replace(' ', '')}` : '')

    const cp = s.ctxPct ?? 0
    const cells: Cell[] = [{
      icon: 'ctx', value: `${cp}%`,
      sub: s.ctxWin ? `${k(s.ctxTok ?? 0)} / ${k(s.ctxWin)}` : '',
      frac: cp / 100,
      color: (s.ctxTok ?? 0) >= NAG_HARD ? BAD : (s.ctxTok ?? 0) >= NAG ? (tone(cp) === BAD ? BAD : WARN) : tone(cp),
    }]
    const tok = s.ctxTok ?? 0
    const nag = !e.props.isWorking && tok >= Math.max(NAG, s.snooze ?? 0)
    if (s.h5 !== undefined) cells.push({ icon: 'clock', value: `${s.h5}%`, sub: `5h · ${until(s.h5Reset)}`, frac: s.h5 / 100, color: tone(s.h5) })
    if (s.wk !== undefined) cells.push({ icon: 'cal', value: `${s.wk}%`, sub: `7d · ${until(s.wkReset)}`, frac: s.wk / 100, color: tone(s.wk) })
    const ttl = s.sub ? TTL_SUB : TTL_API
    const rem = s.lastAt ? s.lastAt + ttl - now : 0
    if (e.props.isWorking) cells.push({ icon: 'flame', value: 'Warm', sub: 'cache · active', frac: 1, color: WARMC, hot: true })
    else if (rem > 0) cells.push({ icon: 'flame', value: 'Warm', sub: `cache · ${left(rem).replace(' ', '')} left`, frac: rem / ttl, color: WARMC, hot: true })
    else cells.push({ icon: 'snow', value: 'Cold', sub: s.lastAt ? 'cache · expired' : 'cache · no reply yet', frac: 0, color: COOL, hot: true })

    const { Box, Text, Button } = $.ui.resolve(e)
    // Three flavours: cache cold (Clear is free, anything else re-reads it all),
    // cache about to expire (compact now while it's cheap), or just big.
    const isCold = s.lastAt > 0 && rem <= 0
    const isExpiring = !isCold && rem > 0 && rem <= 10 * 60_000
    const compactBtn = <Button key="compact" label="Compact" variant={isCold ? 'secondary' : 'primary'} onPress={() => void $.session.compact()} />
    const clearBtn = <Button key="clear" label="Clear" variant={isCold ? 'primary' : 'secondary'} onPress={() => void $.prompt.fill({ text: '/clear' })} />
    const nagRow = nag ? (
      <Box flexDirection="row" alignItems="center" gap={1} paddingX={1}>
        <Text color={isCold ? COOL : tok >= NAG_HARD ? BAD : WARN}>●</Text>
        <Text dimColor>
          {isCold
            ? `Cache cold: next message re-reads ${k(tok)}. Clear is free.`
            : isExpiring
              ? `Cache expires in ${left(rem)}: compact now while it's cheap.`
              : `${k(tok)} in context: each turn re-sends all of it.`}
        </Text>
        {isCold ? clearBtn : compactBtn}
        {isCold ? compactBtn : clearBtn}
        <Button key="later" label="Later" dimColor onPress={() => update($, snap, x => ({ ...x, snooze: tok + 100_000 }))} />
      </Box>
    ) : null

    if (e.surface === 'desktop' || e.surface === 'vscode' || e.surface === 'mobile') {
      const { Svg } = $.ui.resolve(e) as { Svg: (p: { source: string; alt: string; width?: number; height?: number }) => unknown }
      return (
        <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" paddingX={1}>
          {cells.map(c => (
            <Box key={c.icon} flexDirection="row" alignItems="center" gap={1}>
              <Svg source={gauge(c)} alt={`${c.value} ${c.sub}`} width={24} height={28} />
              <Text bold color={c.hot ? c.color : undefined}>{c.value}</Text>
              <Text dimColor>{c.sub}</Text>
            </Box>
          ))}
        </Box>
        {nagRow}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between" paddingX={1}>
        {cells.map(c => (
          <Text key={c.icon}>
            <Text color={c.color}>{ring(c.frac)} </Text>
            <Text bold color={c.hot ? c.color : undefined}>{c.value}</Text>
            
            {c.sub ? <Text dimColor> {c.sub}</Text> : null}
          </Text>
        ))}
      </Box>
      {nagRow}
      </Box>
    )
  })
}
