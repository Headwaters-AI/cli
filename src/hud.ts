/**
 * The state's heads-up display (#2091): a short, fixed-layout summary of a state's proof that
 * keeps an agent and its human oriented over a long session. It is read from the proof as
 * `state:get --json` reads it (GET /v1/states/{id}/proof?format=json), and never shows the tree;
 * the detail is one `hw state:get "<key>"` away.
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

/** proved, refuted or open: every root proved is proved, any root refuted is refuted. */
export function overall(premises: ProofPremise[]): string {
  const roots = premises.filter(isRoot)
  if (roots.length === 0) return 'open'
  if (roots.some((r) => r.truth === 'refuted')) return 'refuted'
  if (roots.every((r) => r.truth === 'proved')) return 'proved'
  return 'open'
}

/** The candidate to try next: the number the last line names, else the first OR's next_to_try. */
export function nextToTry(proof: Proof): ProofPremise | undefined {
  const premises = proof.premises ?? []
  const named = /Next to try: ([0-9]+(?:\.[0-9]+)*)/.exec((proof.summary ?? []).join(' '))?.[1]
  if (named) {
    const hit = premises.find((p) => p.number === named)
    if (hit) return hit
  }
  for (const p of premises) {
    if (p.next_to_try && p.truth === 'open') {
      const hit = premises.find((q) => q.key === p.next_to_try)
      if (hit) return hit
    }
  }
  return undefined
}

function list(items: string[], max = 2): string {
  return items.length <= max ? items.join(', ') : `${items.slice(0, max).join(', ')} +${items.length - max}`
}

/** What is waiting, and on whom: "human on 1.3", "environment on 2.1", "test 1.4 on 1.2". */
export function waiting(premises: ProofPremise[]): string[] {
  const out: string[] = []
  for (const p of premises) {
    if (!p.await || p.await === 'none' || p.truth !== 'open') continue
    if (p.await === 'human' || p.await === 'environment') {
      out.push(`${p.await} on ${p.number}`)
    } else {
      const t = premises.find((q) => q.key === p.await)
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

/** The HUD: three lines, fixed layout, about 60 to 120 tokens whatever the size of the state. */
export function hudLines(proof: Proof, id: string, as?: string): string[] {
  const premises = proof.premises ?? []
  if (premises.length === 0) {
    return [`HUD · ${shortId(id)} · empty`, 'next: add the goal: hw state:add "<goal>" "<what it is>" --role goal']
  }
  const roots = premises.filter(isRoot)
  const root = roots[0]
  const goal = root ? `"${cut(root.key)}"${roots.length > 1 ? ` +${roots.length - 1}` : ''}` : '(no root)'
  const proved = premises.filter((p) => p.truth === 'proved').length
  const head = `HUD · ${shortId(id)} · ${goal} · ${overall(premises)} · ${proved}/${premises.length} proved`

  const next = nextToTry(proof)
  const parts = [next ? `next: ${next.number} ${cut(next.key)}${typeof next.p === 'number' ? ` (p ${next.p.toFixed(2)})` : ''}` : 'next: none']
  const w = waiting(premises)
  if (w.length > 0) parts.push(`waiting: ${list(w)}`)
  const c = claims(premises, as)
  if (c) parts.push(c)

  const drill = next ?? root
  return [head, parts.join(' · '), `drill: hw state:get "${drill ? drill.key : ''}"`]
}

/** One line for a status bar: the HUD's first two lines, shorter. */
export function hudStatusLine(proof: Proof, id: string, as?: string, width?: number): string {
  const [head, second] = hudLines(proof, id, as)
  const line = `${head.replace(/^HUD · /, '')} · ${second}`
  return width && width > 10 ? cut(line, width) : line
}

// ---- the toggle -------------------------------------------------------------------------------

/** The nearest .headwaters/hud from `from` up, and the mode in it; auto when there is none. */
export function readHudMode(from: string): HudMode {
  let dir = path.resolve(from)
  for (;;) {
    try {
      const m = fs.readFileSync(path.join(dir, STATE_DIR, HUD_FILE), 'utf8').trim()
      if ((HUD_MODES as string[]).includes(m)) return m as HudMode
    } catch {
      // not here
    }
    const up = path.dirname(dir)
    if (up === dir) return 'auto'
    dir = up
  }
}

/** Whether a hook shows the HUD: off never, on always, auto when there is a state. */
export function hudShows(mode: HudMode, hasState: boolean): boolean {
  return mode === 'on' || (mode === 'auto' && hasState)
}

// ---- the post-tool throttle -------------------------------------------------------------------

const WRITE = /\bhw\s+state:(add|edit|delete|refine|choices|decide|claim)\b/

/** Whether a hook event's tool call was an `hw state:` write (Claude Code and Codex both name it Bash). */
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
