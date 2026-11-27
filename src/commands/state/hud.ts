import fs from 'node:fs'
import path from 'node:path'
import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {HwClient} from '../../client.js'
import {ReplyCommand, STATE_DIR, findStateFile, stateIdFlag} from '../../foreman.js'
import {
  HUD_COUNT_FILE, HUD_FILE, HUD_MODES, HudMode, Proof, contextOutput, formatHud, hudLines, hudShows, hudStatusLine,
  isStateWrite, readHud, shortId, throttleKey, throttleStep,
} from '../../hud.js'

const HOOKS = ['user-prompt', 'post-tool', 'statusline', 'session-start', 'stop', 'session-end'] as const
type Hook = typeof HOOKS[number]

/** A hook never waits on the network longer than this, and never runs longer than HARD_STOP_MS. */
const NETWORK_MS = 5000
const HARD_STOP_MS = 8000

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms)
    p.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
  })
}

/** The hook event on stdin, or {} when there is none or it is not JSON. */
async function readEvent(): Promise<Record<string, unknown>> {
  if (process.stdin.isTTY) return {}
  const raw = await within(new Promise<string>((resolve) => {
    let buf = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c) => { buf += c })
    process.stdin.on('end', () => resolve(buf))
    process.stdin.on('error', () => resolve(buf))
  }), 1500).catch(() => '')
  try {
    const ev = JSON.parse(raw) as unknown
    return ev && typeof ev === 'object' && !Array.isArray(ev) ? ev as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

export default class StateHud extends ReplyCommand {
  static description =
    'The state\'s heads-up display: three short lines, fixed layout, never the tree: the state, one root goal ' +
    '(--goal pins it; else the open root goal with children written last), proved, refuted or open as state:get ' +
    'shows it, how many premises in its tree are proved; the next step (the candidate to try, else the first thing ' +
    'its last line asks, such as "refine 7.2"), what waits on the human, the environment or a test, and the claims ' +
    '(with --as, yours); then the command that shows the detail. "on", "off" or "auto" sets when the hooks show it, ' +
    'in .headwaters/hud next to the state file, with the pinned goal (auto, the default: when the directory has a ' +
    'state). --hook <event> reads a hook event on stdin and prints that ' +
    'hook\'s output (Claude Code and Codex): user-prompt each user message, post-tool after an hwai state: write or ' +
    `every 15 tool calls, statusline one line for the status bar, and session-start, stop and session-end. A hook ` +
    'never blocks and never fails: on any error it prints nothing and exits 0. Free.'

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --as builder-A',
    '<%= config.bin %> <%= command.id %> --goal "the dinner is planned"',
    '<%= config.bin %> <%= command.id %> --goal ""',
    '<%= config.bin %> <%= command.id %> off',
    '<%= config.bin %> <%= command.id %> auto',
    '<%= config.bin %> <%= command.id %> --hook user-prompt < event.json',
  ]

  static flags = {
    ...BaseCommand.baseFlags,
    ...stateIdFlag,
    as: Flags.string({description: 'Whose claims to show as "you hold": the name their writes carry as --as.', env: 'HEADWATERS_AS'}),
    goal: Flags.string({description: 'Pin the root goal the HUD is about (a premise key), kept in .headwaters/hud; "" unpins it.'}),
    hook: Flags.string({description: 'Run as a hook: read the hook event on stdin and print the hook\'s output.', options: [...HOOKS]}),
    harness: Flags.string({description: 'With --hook: the harness, which names the session (claude-code:<id> or codex:<id>).', options: ['claude-code', 'codex'], default: 'claude-code'}),
  }

  // ignoreStdin: oclif would otherwise take a piped hook event as the mode, and the hook would see no event
  static args = {mode: Args.string({description: 'on, off or auto: when the hooks show the HUD. Left out, print it.', required: false, options: [...HUD_MODES], ignoreStdin: true})}

  async catch(err: Error & {exitCode?: number}): Promise<unknown> {
    // a hook never fails the agent, whatever went wrong, flag errors included
    if (this.argv.includes('--hook')) process.exit(0)
    return super.catch(err)
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(StateHud)
    if (flags.hook) {
      setTimeout(() => process.exit(0), HARD_STOP_MS)
      try {
        await this.hook(flags.hook as Hook, flags)
      } catch {
        // nothing: a hook prints nothing on any error
      }
      process.exit(0)
    }

    let settings = readHud(process.cwd())
    if (args.mode || flags.goal !== undefined) {
      const found = findStateFile()
      const dir = found ? path.dirname(found.file) : path.join(process.cwd(), STATE_DIR)
      fs.mkdirSync(dir, {recursive: true})
      const file = path.join(dir, HUD_FILE)
      const goal = flags.goal === undefined ? settings.goal : flags.goal.trim() || undefined
      settings = {mode: (args.mode as HudMode | undefined) ?? settings.mode, goal}
      fs.writeFileSync(file, formatHud(settings))
      if (!this.jsonEnabled()) {
        if (args.mode) {
          const what = {on: 'the hooks always show it', off: 'the hooks never show it', auto: 'the hooks show it when this directory has a state'}[settings.mode]
          this.log(`HUD ${settings.mode}: ${what} (${file}).`)
        }
        if (flags.goal !== undefined) this.log(goal ? `HUD goal pinned: "${goal}" (${file}).` : `HUD goal unpinned (${file}).`)
      }
      // setting the mode is all it does; pinning a goal alone then shows the HUD for it
      if (args.mode) return {...settings, file}
    }

    const id = this.stateId(flags)
    const proof = await this.proof(this.makeClient(flags), id).catch((err: Error) => this.error(err.message))
    if (settings.goal && !(proof.premises ?? []).some((p) => p.key === settings.goal)) {
      process.stderr.write(`warn: the pinned goal "${settings.goal}" is not a premise of this state; showing the default goal.\n`)
    }
    const lines = hudLines(proof, id, flags.as, settings.goal)
    if (!this.jsonEnabled()) this.log(lines.join('\n'))
    return {state_id: id, ...settings, lines}
  }

  private async proof(client: HwClient, id: string): Promise<Proof> {
    const got = await client.stateReply('GET', this.statePath(id, '/proof'), {params: {format: 'json'}})
    if (!got.ok) throw new Error(typeof got.data.text === 'string' ? got.data.text : `HTTP ${got.status}`)
    return got.data as Proof
  }

  private async hook(hook: Hook, flags: {'state-id'?: string; as?: string; harness: string; 'base-url'?: string; token?: string; 'api-key'?: string}): Promise<void> {
    const event = await readEvent()
    const ws = event.workspace as Record<string, unknown> | undefined
    const cwd = (typeof event.cwd === 'string' && event.cwd) || (typeof ws?.current_dir === 'string' && ws.current_dir) || process.cwd()
    const found = findStateFile(cwd)
    const id = flags['state-id'] || found?.id
    const session = typeof event.session_id === 'string' && event.session_id ? `${flags.harness}:${event.session_id}` : process.env.HEADWATERS_SESSION?.trim()
    const out = (s: string) => process.stdout.write(s + '\n')

    if (hook === 'session-start') {
      // every hwai write in the session then records it, and session-end releases its claims
      const envFile = process.env.CLAUDE_ENV_FILE
      if (session && envFile) fs.appendFileSync(envFile, `export HEADWATERS_SESSION=${session}\n`)
      if (!id) {
        out(contextOutput('SessionStart', 'No state in this directory (no .headwaters/state). hwai state:create --use creates one; hwai state:use <id> uses one of yours.'))
        return
      }
      const got = await within(this.makeClient(flags).stateReply('GET', this.statePath(id, '/proof')), NETWORK_MS)
      const text = typeof got.data.text === 'string' ? got.data.text : ''
      out(contextOutput('SessionStart', got.ok && text ? `State ${id} (${found?.file ?? 'HEADWATERS_STATE_ID'}):\n${text}` : `State ${id} could not be read: ${text.slice(0, 300) || `HTTP ${got.status}`}`))
      return
    }

    if (!id) {
      // only "on" shows anything without a state, and only in the HUD's own slots
      if ((hook === 'user-prompt' || hook === 'post-tool' || hook === 'statusline') && readHud(cwd).mode === 'on') {
        const none = 'HUD · no state here: hwai state:create --use makes one'
        out(hook === 'statusline' ? none : contextOutput(hook === 'user-prompt' ? 'UserPromptSubmit' : 'PostToolUse', none))
      }
      return
    }
    const client = this.makeClient(flags)

    if (hook === 'session-end') {
      if (session) await within(client.stateReply('POST', this.statePath(id, '/release-session'), {body: {session}}), NETWORK_MS)
      return
    }
    if (hook === 'stop') {
      const proof = await within(this.proof(client, id), NETWORK_MS)
      const last = (proof.summary ?? []).filter(Boolean).join(' ')
      if (last) out(JSON.stringify({systemMessage: `State ${shortId(id)}: ${last}`}))
      return
    }

    const settings = readHud(cwd)
    if (!hudShows(settings.mode, true)) return
    if (hook === 'post-tool') {
      const dir = found ? path.dirname(found.file) : path.join(cwd, STATE_DIR)
      const file = path.join(dir, HUD_COUNT_FILE)
      let counts: Record<string, number> = {}
      try {
        counts = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, number>
      } catch {
        // the first call, or a damaged file: start again
      }
      const step = throttleStep(counts, throttleKey(event), isStateWrite(event))
      try {
        fs.mkdirSync(dir, {recursive: true})
        fs.writeFileSync(file, JSON.stringify(step.counts))
      } catch {
        // a read-only directory: inject on writes only
      }
      if (!step.inject) return
    }
    const proof = await within(this.proof(client, id), NETWORK_MS)
    if (hook === 'statusline') {
      // Claude Code passes the terminal width in COLUMNS
      const cols = Number(process.env.COLUMNS)
      out(hudStatusLine(proof, id, flags.as, Number.isFinite(cols) && cols > 0 ? cols - 4 : undefined, settings.goal))
      return
    }
    out(contextOutput(hook === 'user-prompt' ? 'UserPromptSubmit' : 'PostToolUse', hudLines(proof, id, flags.as, settings.goal).join('\n')))
  }
}
