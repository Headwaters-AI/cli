/**
 * The state's heads-up display (#2091): a short, fixed-layout summary of a state's proof that
 * keeps an agent and its human oriented over a long session. It is read from the proof as
 * `state:get --json` reads it (GET /v1/states/{id}/proof?format=json), and never shows the tree;
 * the detail is one `hwai state:get "<key>"` away.
 *
 * Everything here is pure, so scripts/check.mjs covers it without a network: the layout, the
 * toggle file, which tool calls are state writes, and the post-tool throttle.
 */
import fs from 'node:fs'
import path from 'node:path'
import {STATE_DIR} from './foreman.js'

/** One premise as the proof's JSON gives it (only the fields the HUD reads). */
export interface ProofPremise {
  number: string
  key: string
  role?: string | null
  truth?: string | null
  p?: number | null
  await?: string | null
  claimed_by?: string | null
  next_to_try?: string | null
  children?: string[] | null
}

export interface Proof {
  premises?: ProofPremise[]
  summary?: string[]
}

export type HudMode = 'on' | 'off' | 'auto'
export const HUD_MODES: HudMode[] = ['on', 'off', 'auto']
export const HUD_FILE = 'hud'
export const HUD_COUNT_FILE = 'hud.count'
/** Inject after this many tool calls without one, whatever they were. */
export const HUD_EVERY = 15
const KEY_MAX = 32

/** A key cut to `max` characters, with an ellipsis when cut. */
export function cut(s: string, max = KEY_MAX): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + '…'
}

/** fs_QPSOHe8tyW... as fs_QPSO… */
export function shortId(id: string): string {
  return id.length <= 8 ? id : id.slice(0, 7) + '…'
}

function isRoot(p: ProofPremise): boolean {
  return !p.number.includes('.')
}

/**
 * The goal the HUD is about. Pinned (`--goal`), when that key is a premise. Otherwise the open
 * root goal with children that was written last; then any open root goal, any root goal, any
 * root. "Written last": the proof's JSON has no timestamps, and lists premises in the order the
 * server first stored each key, so the last such root in that list is the newest.
 */
export function chooseRoot(premises: ProofPremise[], pinned?: string): ProofPremise | undefined {
  if (pinned) {
    const hit = premises.find((p) => p.key === pinned)
    if (hit) return hit
  }
  const roots = premises.filter(isRoot)
  const tiers = [
    roots.filter((r) => r.role === 'goal' && r.truth === 'open' && (r.children ?? []).length > 0),
    roots.filter((r) => r.role === 'goal' && r.truth === 'open'),
    roots.filter((r) => r.role === 'goal'),
    roots,
  ]
  for (const t of tiers) if (t.length > 0) return t[t.length - 1]
  return undefined
}

/** The premise and everything refined under it, each once. */
export function treeOf(premises: ProofPremise[], root: ProofPremise): ProofPremise[] {
  const byKey = new Map(premises.map((p) => [p.key, p]))
  const seen = new Set<string>()
  const out: ProofPremise[] = []
  const stack = [root.key]
  while (stack.length > 0) {
    const k = stack.pop() as string
    if (seen.has(k)) continue
    seen.add(k)
    const p = byKey.get(k)
    if (!p) continue
    out.push(p)
    for (const c of [...(p.children ?? [])].reverse()) stack.push(c)
  }
  return out
}

/** The server's last line for this root: "7 Open. ..." when there are several goals, the bare line when one. */
export function rootSummary(proof: Proof, root: ProofPremise): string | undefined {
  const lines = (proof.summary ?? []).filter(Boolean)
  const mine = lines.find((l) => l.startsWith(root.number + ' '))
  if (mine) return mine.slice(root.number.length + 1)
  const goals = (proof.premises ?? []).filter((p) => isRoot(p) && p.role === 'goal')
  if (goals.length <= 1 && lines[0] && /^(Open|Proved|Refuted)\b/.test(lines[0])) return lines[0]
  return undefined
}

/** The first item of a list the server joined with ", " and " and ", outside quotes. */
export function firstItem(list: string): string {
  let q = false
  for (let i = 0; i < list.length; i++) {
    if (list[i] === '"') q = !q
    if (!q && (list.startsWith(', ', i) || list.startsWith(' and ', i))) return list.slice(0, i)
  }
  return list
}

/** What the last line's "Proved when" asks first, as a step: "refine 7.2", "test 1.4 on 1.2.1". */
export function stepOf(item: string): {step: string; ref: string} | undefined {
  const m = /^(\S+|"[^"]*") (is refined or tested|is refined|is stated|passes on (.+)|passes|waits on .+|is answered by .+)$/.exec(item.trim())
  if (!m) return undefined
  const ref = m[1]
  const what = m[2]
  if (what.startsWith('waits on') || what.startsWith('is answered by')) return undefined
  if (what === 'is refined') return {step: `refine ${ref}`, ref}
  if (what === 'is refined or tested') return {step: `refine or test ${ref}`, ref}
  if (what === 'is stated') return {step: `state ${ref}`, ref}
  if (what === 'passes') return {step: `run test ${ref}`, ref}
  return {step: `test ${ref} on ${m[3]}`, ref}
}

export interface Next {
  text: string
  premise?: ProofPremise
}

/**
 * The next step for the root, from the server's last line: the candidate it names to try, else
 * the first thing "Proved when" asks that is not a wait. None when the goal is proved or refuted,
 * or when everything waits.
 */
export function nextStep(proof: Proof, root: ProofPremise): Next {
  const premises = proof.premises ?? []
  const byRef = (ref: string) => premises.find((p) => p.number === ref) ?? premises.find((p) => `"${p.key}"` === ref)
  if (root.truth === 'proved') return {text: 'none, proved'}
  if (root.truth === 'refuted') return {text: 'none, refuted'}
  const line = rootSummary(proof, root) ?? ''
  const tryNext = /Next to try: (.+?)\.(?: Proved when|$)/.exec(line)?.[1]
  if (tryNext) {
    const first = firstItem(tryNext)
    const ref = /^(\S+|"[^"]*")/.exec(first)?.[1] ?? first
    const p = byRef(ref)
    if (p) return {text: `try ${p.number} ${cut(p.key)}${typeof p.p === 'number' ? ` (p ${p.p.toFixed(2)})` : ''}`, premise: p}
  }
  const when = /Proved when (.+)\.$/.exec(line)?.[1]
  if (when) {
    let rest = when
    while (rest) {
      const item = firstItem(rest)
      const s = stepOf(item)
      if (s) {
        const p = byRef(s.ref)
        // a numbered step is followed by its key; a quoted one already is its key
        return {text: p && !s.ref.startsWith('"') ? `${s.step} ${cut(p.key)}` : s.step, premise: p}
      }
      rest = rest.slice(item.length).replace(/^(, | and )/, '')
    }
    return {text: 'none, everything waits'}
  }
  return {text: 'none'}
}

function list(items: string[], max = 2): string {
  return items.length <= max ? items.join(', ') : `${items.slice(0, max).join(', ')} +${items.length - max}`
}

/** What is waiting, and on whom: "human on 1.3", "environment on 2.1", "test 1.4 on 1.2". */
export function waiting(premises: ProofPremise[], all: ProofPremise[] = premises): string[] {
  const out: string[] = []
  for (const p of premises) {
    if (!p.await || p.await === 'none' || p.truth !== 'open') continue
    if (p.await === 'human' || p.await === 'environment') {
      out.push(`${p.await} on ${p.number}`)
    } else {
      const t = all.find((q) => q.key === p.await)
      out.push(`test ${t ? t.number : cut(p.await, 16)} on ${p.number}`)
    }
  }
  return out
}

/** The claims: with `as`, only theirs ("you hold: 1.2"); without, every one ("held: 1.2 builder-A"). */
export function claims(premises: ProofPremise[], as?: string): string | undefined {
  const held = premises.filter((p) => p.claimed_by)
  if (as) {
    const mine = held.filter((p) => p.claimed_by === as).map((p) => p.number)
    return `you hold: ${mine.length > 0 ? list(mine, 3) : 'nothing'}`
  }
  if (held.length === 0) return undefined
  return `held: ${list(held.map((p) => `${p.number} ${cut(p.claimed_by as string, 16)}`))}`
}

/**
 * The HUD: three lines, fixed layout, about 60 to 120 tokens whatever the size of the state. It is
 * about one root goal (see chooseRoot); its status is the server's truth for that root, its count
 * the root's own tree, and its next step the server's last line for that root.
 */
export function hudLines(proof: Proof, id: string, as?: string, goal?: string): string[] {
  const premises = proof.premises ?? []
  if (premises.length === 0) {
    return [`HUD · ${shortId(id)} · empty`, 'next: add the goal: hwai state:add "<goal>" "<what it is>" --role goal']
  }
  const root = chooseRoot(premises, goal) as ProofPremise
  const others = premises.filter(isRoot).filter((r) => r.key !== root.key).length
  const tree = treeOf(premises, root)
  const proved = tree.filter((p) => p.truth === 'proved').length
  const head = `HUD · ${shortId(id)} · ${root.number} "${cut(root.key)}"${others > 0 ? ` +${others} other root${others === 1 ? '' : 's'}` : ''}` +
    ` · ${root.truth ?? 'open'} · ${proved}/${tree.length} proved`

  const next = nextStep(proof, root)
  const parts = [`next: ${next.text}`]
  const w = waiting(tree, premises)
  if (w.length > 0) parts.push(`waiting: ${list(w)}`)
  const c = claims(premises, as)
  if (c) parts.push(c)

  return [head, parts.join(' · '), `drill: hwai state:get "${(next.premise ?? root).key}"`]
}

/** One line for a status bar: the HUD's first two lines, shorter. */
export function hudStatusLine(proof: Proof, id: string, as?: string, width?: number, goal?: string): string {
  const [head, second] = hudLines(proof, id, as, goal)
  const line = `${head.replace(/^HUD · /, '')} · ${second}`
  return width && width > 10 ? cut(line, width) : line
}

// ---- the toggle and the pinned goal -------------------------------------------------------------

export interface HudSettings {
  mode: HudMode
  goal?: string
}

/** .headwaters/hud: the mode on its first line, then `goal: <key>` when a goal is pinned. */
export function parseHud(text: string): HudSettings {
  const lines = text.split('\n').map((l) => l.trim())
  const mode = (HUD_MODES as string[]).includes(lines[0]) ? lines[0] as HudMode : 'auto'
  const g = lines.find((l) => l.startsWith('goal: '))?.slice(6).trim()
  return g ? {mode, goal: g} : {mode}
}

export function formatHud(s: HudSettings): string {
  return s.mode + '\n' + (s.goal ? `goal: ${s.goal}\n` : '')
}

/** The nearest .headwaters/hud from `from` up; auto and no goal when there is none. */
export function readHud(from: string): HudSettings & {file?: string} {
  let dir = path.resolve(from)
  for (;;) {
    const file = path.join(dir, STATE_DIR, HUD_FILE)
    try {
      return {...parseHud(fs.readFileSync(file, 'utf8')), file}
    } catch {
      // not here
    }
    const up = path.dirname(dir)
    if (up === dir) return {mode: 'auto'}
    dir = up
  }
}

export function readHudMode(from: string): HudMode {
  return readHud(from).mode
}

/** Whether a hook shows the HUD: off never, on always, auto when there is a state. */
export function hudShows(mode: HudMode, hasState: boolean): boolean {
  return mode === 'on' || (mode === 'auto' && hasState)
}

// ---- the post-tool throttle -------------------------------------------------------------------

const WRITE = /\bhwai\s+state:(add|edit|delete|refine|choices|decide|claim)\b/

/** Whether a hook event's tool call was an `hwai state:` write (Claude Code and Codex both name it Bash). */
export function isStateWrite(event: Record<string, unknown>): boolean {
  const input = event.tool_input as Record<string, unknown> | string | undefined
  if (input === undefined || input === null) return false
  let cmd: unknown = typeof input === 'string' ? input : input.command ?? input.cmd
  if (Array.isArray(cmd)) cmd = cmd.join(' ')
  return typeof cmd === 'string' && WRITE.test(cmd)
}

/** Who the counter is for: the session, and the subagent when the call is a subagent's. */
export function throttleKey(event: Record<string, unknown>): string {
  const s = typeof event.session_id === 'string' && event.session_id ? event.session_id : 'none'
  return typeof event.agent_id === 'string' && event.agent_id ? `${s}:${event.agent_id}` : s
}

/**
 * One post-tool event against the counters: inject after a state write, or once HUD_EVERY calls
 * have gone by since the last injection. Returns whether to inject and the counters to keep.
 */
export function throttleStep(counts: Record<string, number>, key: string, write: boolean, every = HUD_EVERY
): {inject: boolean; counts: Record<string, number>} {
  const n = (counts[key] ?? 0) + 1
  const inject = write || n >= every
  const next = {...counts}
  delete next[key]
  next[key] = inject ? 0 : n
  // keep the most recent sessions only
  const keys = Object.keys(next)
  for (const k of keys.slice(0, Math.max(0, keys.length - 50))) delete next[k]
  return {inject, counts: next}
}

/** The hook output that adds `text` to the model's context (Claude Code and Codex take the same shape). */
export function contextOutput(hookEventName: string, text: string): string {
  return JSON.stringify({hookSpecificOutput: {hookEventName, additionalContext: text}})
}
