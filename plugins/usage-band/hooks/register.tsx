import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit, SessionUsage } from 'claude-code'

import type { Snap } from '../types'

// Prompt-cache TTL guess: subscriptions (rate limits reported) get 1h, API keys 5m.
// Replaced by what the API's own cache counts show once a gap proves it (s.ttl).
const TTL_SUB = 60 * 60_000
const TTL_API = 5 * 60_000
// Below this many prompt tokens a hit or miss says nothing worth showing.
const MIN_PROMPT = 20_000
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

type Limits = readonly SessionRateLimit[]

// An update without limits keeps the ones already shown.
const withLimits = (s: Snap, rl: Limits): Snap => {
  if (!rl.length) return s
  const h5 = rl.find(r => r.kind === 'five_hour')
  const wk = rl.find(r => r.kind === 'seven_day')
  return {
    ...s, sub: true,
    h5: h5?.percentUsed, h5Reset: h5?.resetsAt,
    wk: wk?.percentUsed, wkReset: wk?.resetsAt,
  }
}

// Claude Code only learns the limits from a response; until then use the last known ones.
const fold = (u: Pick<SessionUsage, 'context' | 'rateLimits'>, cached?: Limits) => (s: Snap): Snap => ({
  ...withLimits(s, u.rateLimits.length ? u.rateLimits : cached ?? []),
  ctxPct: u.context.percent, ctxTok: u.context.tokens, ctxWin: u.context.window,
})

// The limits are the account's, shared by every session: the newest response in
// any project writes them, and every open session picks them up within a minute.
type SavedLimits = { at: number; rl: Limits }
const parseLimits = (v: unknown): SavedLimits | undefined =>
  Array.isArray(v) ? { at: 0, rl: v as Limits }
    : v && typeof v === 'object' && Array.isArray((v as SavedLimits).rl) ? (v as SavedLimits) : undefined

// Stored limits whose window has since reset start that window over at 0%.
const aged = (rl: Limits, now: number): Limits =>
  rl.map(r => (r.resetsAt && Date.parse(r.resetsAt) <= now ? { kind: r.kind, percentUsed: 0 } : r))

// When each conversation last got a response, kept across restarts so a resumed
// session knows its cache is still warm. Newest 30 conversations only.
type Seen = Record<string, number>
const remember = async ($: EngineInterface, t: number) => {
  const [id, got] = await Promise.all([$.session.id(), $.store.get('lastAt')])
  const seen = { ...((got ?? {}) as Seen), [id]: t }
  const keep = Object.entries(seen).sort((a, b) => b[1] - a[1]).slice(0, 30)
  await $.store.set('lastAt', Object.fromEntries(keep))
}

// A conversation with nothing stored yet: its transcript was last written by the
// last response, so the file's modification time stands in for it. One stat call.
const transcriptAt = async ($: EngineInterface, id: string): Promise<number> => {
  try {
    const [cwd, cfg, profile, home] = await Promise.all([
      $.session.cwd(), $.env.get('CLAUDE_CONFIG_DIR'), $.env.get('USERPROFILE'), $.env.get('HOME'),
    ])
    const base = cfg ?? `${profile ?? home}/.claude`
    const st = await $.fs.stat(`${base}/projects/${cwd.replace(/[^A-Za-z0-9]/g, '-')}/${id}.jsonl`)
    return st.kind === 'file' ? st.mtimeMs : 0
  } catch {
    return 0
  }
}

// Last limits written to the store, so a response that moved nothing writes nothing.
let storedLimits = ''

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const [now, u, ttl, seen, limits, id] = await Promise.all([
      $.clock.now(), $.session.usage(), $.store.get('ttl'), $.store.get('lastAt'), $.store.get('limits'), $.session.id(),
    ])
    const got = parseLimits(limits)
    const cached = got && aged(got.rl, now)
    // A restart loses the session's state; the stored time brings it back.
    // A /clear starts a new conversation id with no transcript yet, so it starts cold.
    const saved = ((seen ?? {}) as Seen)[id] || (u.context.tokens ? await transcriptAt($, id) : 0)
    await update($, snap, s => ({
      ...fold(u, cached)(s),
      now,
      limitsAt: u.rateLimits.length ? now : got?.at ?? 0,
      ttl: ttl === '5m' || ttl === '1h' ? ttl : s.ttl,
      lastAt: Math.max(s.lastAt, Math.min(saved, now)),
    }))
    // One redraw a minute keeps the countdowns honest; no model calls, no tokens.
    // It also picks up limits another project's session saved since.
    $.clock.every(60_000, async () => {
      const [t, v] = await Promise.all([$.clock.now(), $.store.get('limits')])
      const saved = parseLimits(v)
      await update($, snap, s => (saved && saved.at > (s.limitsAt ?? 0)
        ? { ...withLimits(s, aged(saved.rl, t)), limitsAt: saved.at, now: t }
        : { ...s, now: t }))
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
      limitsAt: e.rateLimits.length ? now : s.limitsAt,
      warned: tok >= NAG,
      snooze: tok < NAG ? 0 : s.snooze,
    }))
    const rl = JSON.stringify(e.rateLimits)
    if (e.rateLimits.length && rl !== storedLimits) {
      storedLimits = rl
      await $.store.set('limits', { at: now, rl: e.rateLimits })
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, snap, s => ({ ...s, lastAt: now, now }))
    await remember($, now)
    return next(e)
  })

  // The first response of each turn says what the cache really did with the
  // conversation sent after the idle gap: read from cache (hit) or paid in full (miss).
  on('turn.step', async function* ($, e, next) {
    const first = e.index === 0 && !e.agentId
    const [before, sentAt] = first ? await Promise.all([read($, snap), $.clock.now()]) : [undefined, 0]
    const r = yield* next(e)
    const u = r.usage
    if (!before || !u) return r
    const total = u.cache_read_input_tokens + u.cache_creation_input_tokens + u.input_tokens
    if (total < MIN_PROMPT) return r
    const hit = u.cache_read_input_tokens / total >= 0.5
    const gap = before.lastAt ? sentAt - before.lastAt : -1
    const sameModel = !before.model || before.model === u.model
    // A gap longer than 5m that still hits proves the 1h cache; a miss inside
    // the hour on the same model means the cache only lasted 5m.
    let ttl = before.ttl
    if (sameModel && hit && gap > 6 * 60_000) ttl = '1h'
    else if (sameModel && !hit && gap > 6 * 60_000 && gap < 55 * 60_000 && u.cache_read_input_tokens / total < 0.2) ttl = '5m'
    if (ttl && ttl !== before.ttl) await $.store.set('ttl', ttl)
    const ttlMs = (ttl ?? (before.sub ? '1h' : '5m')) === '1h' ? TTL_SUB : TTL_API
    const thoughtWarm = gap >= 0 && gap < ttlMs
    if (!hit && thoughtWarm && sameModel && total >= 50_000) {
      $.ui.toast(`Cache miss: that message re-read ${k(total - u.cache_read_input_tokens)} tokens at full price.`)
    }
    await update($, snap, s => ({
      ...s, ttl, model: u.model, hit: u.cache_read_input_tokens / total,
      missTok: hit ? undefined : total - u.cache_read_input_tokens,
    }))
    return r
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
    // A window whose reset time has passed is back at 0% until the next response says more.
    const limit = (icon: string, label: string, pct?: number, reset?: string) => {
      if (pct === undefined) return
      const isReset = !!reset && Date.parse(reset) <= now
      const p = isReset ? 0 : pct
      cells.push({ icon, value: `${p}%`, sub: isReset ? label : `${label} · ${until(reset)}`, frac: p / 100, color: tone(p) })
    }
    limit('clock', '5h', s.h5, s.h5Reset)
    limit('cal', '7d', s.wk, s.wkReset)
    const ttl = (s.ttl ?? (s.sub ? '1h' : '5m')) === '1h' ? TTL_SUB : TTL_API
    const rem = s.lastAt ? s.lastAt + ttl - now : 0
    // What the last message actually did: ✓ read from cache, ✗ paid full price.
    const last = s.hit === undefined ? '' : s.missTok ? ` · ✗ missed ${k(s.missTok)}` : ` · ✓ hit ${Math.round(s.hit * 100)}%`
    if (e.props.isWorking) cells.push({ icon: 'flame', value: 'Warm', sub: 'cache · active', frac: 1, color: WARMC, hot: true })
    else if (rem > 0) cells.push({ icon: 'flame', value: 'Warm', sub: `cache · ${left(rem).replace(' ', '')} left${last}`, frac: rem / ttl, color: WARMC, hot: true })
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
