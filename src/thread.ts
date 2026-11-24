/**
 * Named chat threads, kept on this machine under ~/.headwaters/threads/<name>.json:
 * `hw maestro:chat --thread <name>`. Each turn sends the whole thread.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {Turn} from './chat.js'

export const THREADS_DIR = path.join(os.homedir(), '.headwaters', 'threads')

export interface ThreadMessage extends Turn {
  ts: string
}

export interface Thread {
  /** The name it was started with. */
  id: string
  /** The whole model, `@alice:maestro-1/gpt-5.4`. */
  model: string
  /** The endpoint the thread runs on, fixed when it starts. */
  endpoint?: string
  system?: string
  created_at: string
  updated_at: string
  messages: ThreadMessage[]
}

export function threadPath(name: string): string {
  // The name names a file, so it must not be able to name any other one:
  // `--thread ../config --delete` would remove the saved credentials.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
    throw new Error(`"${name}" cannot name a thread: use letters, digits, - and _ (at most 64). List them with: hw maestro:chat --threads`)
  }
  return path.join(THREADS_DIR, `${name}.json`)
}

export function loadThread(name: string): Thread | null {
  const p = threadPath(name)
  if (!fs.existsSync(p)) return null
  return JSON.parse(fs.readFileSync(p, 'utf8')) as Thread
}

export function saveThread(t: Thread): void {
  if (!fs.existsSync(THREADS_DIR)) fs.mkdirSync(THREADS_DIR, {recursive: true, mode: 0o700})
  t.updated_at = new Date().toISOString()
  fs.writeFileSync(threadPath(t.id), JSON.stringify(t, null, 2), {mode: 0o600})
}

export function listThreads(): Thread[] {
  if (!fs.existsSync(THREADS_DIR)) return []
  const out: Thread[] = []
  for (const f of fs.readdirSync(THREADS_DIR)) {
    if (!f.endsWith('.json')) continue
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(THREADS_DIR, f), 'utf8')) as Thread)
    } catch { /* skip a corrupt file */ }
  }
  out.sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))
  return out
}
