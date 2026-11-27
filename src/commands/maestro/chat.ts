import {Flags} from '@oclif/core'
import fs from 'node:fs'
import {BaseCommand} from '../../base.js'
import {HwAPIError} from '../../client.js'
import {MESSAGES_ENDPOINT, RESPONSES_ENDPOINT, chatModelProblem, chatPayload, sendChat} from '../../chat.js'
import {ChatCommand, chatRefusal, statelessChatFlags} from '../../chat-command.js'
import {maestroModel, parseModel} from '../../model.js'
import {resolveEndpoint} from '../../routing.js'
import {type Thread, listThreads, loadThread, saveThread, threadPath} from '../../thread.js'
import {parseTemperature} from '../../utils.js'

export default class MaestroChat extends ChatCommand {
  static description =
    'Chat with a face. Stateless: --face names the face, which steers on maestro-1 (--fast: maestro-1-fast), and ' +
    '--decoder names the chat model that writes the reply. Routes to /v1/chat/completions, /v1/responses or ' +
    '/v1/messages from the model catalog; --responses or --messages picks the route. The face\'s style is ' +
    'chosen for each request. --thread <name> keeps a multi-turn chat on this machine ' +
    '(~/.headwaters/threads/<name>.json): the first call starts it with --face and --decoder, later calls go on ' +
    'with it and send the whole thread. The steering is billed per input token plus a small fee per call ' +
    '(hwai models:list --kind upstream), and the decoder at its listed price.'

  static examples = [
    '<%= config.bin %> <%= command.id %> --face @socrates --decoder gpt-5.4 -m "What is virtue?"',
    '<%= config.bin %> <%= command.id %> --face @head~socrates --fast --decoder claude-sonnet-4-6 -m "What is virtue?"',
    '<%= config.bin %> <%= command.id %> --face "(@socrates | @nietzsche)" --decoder gpt-5.4 -m "What is virtue?"',
    '<%= config.bin %> <%= command.id %> --face @socrates --decoder gpt-5.4 --thread justice -m "What is justice?"',
    '<%= config.bin %> <%= command.id %> --thread justice -m "Say more about that"',
    '<%= config.bin %> <%= command.id %> --threads',
    '<%= config.bin %> <%= command.id %> --thread justice --show',
    '<%= config.bin %> <%= command.id %> --thread justice --delete',
  ]

  static flags = {
    ...BaseCommand.baseFlags,
    ...statelessChatFlags(),
    responses: Flags.boolean({description: 'Send it to /v1/responses whatever the catalog says (routing is automatic otherwise).', default: false, exclusive: ['messages']}),
    messages: Flags.boolean({description: 'Send it to /v1/messages, in the Messages format. Not every decoder is served there; a refusal names the route to use.', default: false, exclusive: ['responses']}),
    thread: Flags.string({
      description:
        'Keep this chat as a named thread on this machine (letters, digits, - and _). The first call starts it with ' +
        '--face, --decoder and --system; later calls go on with it, keeping its model, and send the whole thread.',
    }),
    threads: Flags.boolean({description: 'List the saved threads.', exclusive: ['thread']}),
    show: Flags.boolean({description: 'Show the --thread.', dependsOn: ['thread'], exclusive: ['delete']}),
    delete: Flags.boolean({description: 'Delete the --thread.', dependsOn: ['thread'], exclusive: ['show']}),
    yes: Flags.boolean({description: 'Skip the confirmation for --delete.', default: false}),
  }

  protected forcedEndpoint(flags: Record<string, unknown>): string | undefined {
    if (flags.messages) return MESSAGES_ENDPOINT
    return flags.responses ? RESPONSES_ENDPOINT : undefined
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(MaestroChat)
    if (flags.threads) return this.listAll()
    if (flags.thread === undefined) return super.run()
    let saved: Thread | null
    try {
      saved = loadThread(flags.thread)
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err))
    }
    if (flags.show) return this.show(flags.thread, saved)
    if (flags.delete) return this.remove(flags.thread, saved, flags.yes)
    return this.turn(flags, saved)
  }

  private async turn(flags: Record<string, any>, saved: Thread | null): Promise<unknown> {
    const name = flags.thread as string
    const turns: string[] = []
    if (flags.file) {
      if (!fs.existsSync(flags.file)) this.error(`File not found: ${flags.file}`)
      turns.push(fs.readFileSync(flags.file, 'utf8'))
    }
    for (const m of flags.message ?? []) turns.push(m)
    if (turns.length === 0) this.error('Provide at least one --message/-m or --file.')

    let thread: Thread
    if (saved) {
      thread = saved
      if (flags.face || flags.decoder || flags.fast) {
        const named = maestroModel(flags.face ?? thread.model, {fast: flags.fast, decoder: flags.decoder, needsDecoder: true})
        if (named.model && named.model !== thread.model) this.warn(`A thread keeps its model; going on with ${thread.model}.`)
      }
      if (flags.system) this.warn('--system is ignored when going on with a thread.')
    } else {
      if (!flags.face) this.error(`No thread "${name}" yet. Start it with --face and --decoder, e.g. hwai maestro:chat --thread ${name} --face @alice --decoder gpt-5.4 -m "..."`)
      const named = maestroModel(flags.face, {fast: flags.fast, decoder: flags.decoder, needsDecoder: true})
      if (named.problem || !named.model) this.error(named.problem ?? 'Name the face.')
      const now = new Date().toISOString()
      thread = {id: name, model: named.model, system: flags.system, created_at: now, updated_at: now, messages: []}
    }
    const problem = chatModelProblem(thread.model)
    if (problem) this.error(problem)

    const client = this.makeClient(flags)
    if (!thread.endpoint) {
      thread.endpoint = this.forcedEndpoint(flags) ?? (await resolveEndpoint(client, parseModel(thread.model).downstream as string)).endpoint
    }
    const endpoint = thread.endpoint
    for (const t of turns) thread.messages.push({role: 'user', content: t, ts: new Date().toISOString()})
    const json = this.jsonEnabled()
    let payload: Record<string, unknown>
    try {
      payload = chatPayload(endpoint, thread.model, thread.messages.map((m) => ({role: m.role, content: m.content})), {
        system: thread.system,
        maxTokens: flags['max-tokens'],
        temperature: flags.temperature === undefined ? undefined : parseTemperature(flags.temperature, (m) => this.error(m)),
        stream: flags.stream && !json,
        oauthOnly: flags['oauth-only'],
      })
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err))
    }

    try {
      const res = await sendChat(client, endpoint, payload, (d) => process.stdout.write(d), json)
      // Nothing answered means nothing saved, so the same message can be sent again.
      if (!res.text) this.error('No answer came back. Run it again with --no-stream to see what the server said.')
      thread.messages.push({role: 'assistant', content: res.text, ts: new Date().toISOString()})
      saveThread(thread)
      if (json) return {thread: thread.id, model: thread.model, endpoint, assistant: res.text, turns: thread.messages.length}
      if (payload.stream) process.stdout.write('\n')
      else this.log(res.text)
      this.log(`\n[thread ${thread.id}  ·  ${thread.messages.length} turns]`)
      return {thread: thread.id, assistant: res.text}
    } catch (err) {
      if (err instanceof HwAPIError) this.error(await chatRefusal(err, thread.model, endpoint, false, client))
      throw err
    }
  }

  private listAll(): unknown {
    const threads = listThreads()
    if (this.jsonEnabled()) {
      return threads.map((t) => ({thread: t.id, model: t.model, turns: t.messages.length, created_at: t.created_at, updated_at: t.updated_at}))
    }
    if (threads.length === 0) {
      this.log('(no threads)')
      return {}
    }
    for (const t of threads) {
      const last = t.messages.at(-1)
      this.log(`${t.id}  ${t.model}  (${t.messages.length} turns, updated ${t.updated_at})`)
      if (last) this.log(`  ${last.role}: ${last.content.slice(0, 60).replace(/\s+/g, ' ')}${last.content.length > 60 ? '...' : ''}`)
    }
    return {}
  }

  private async remove(name: string, saved: Thread | null, yes: boolean): Promise<unknown> {
    if (!saved) this.error(`No thread "${name}".`)
    await this.confirmOrRefuse(`Delete thread ${name} and its history?`, yes)
    fs.unlinkSync(threadPath(name))
    if (!this.jsonEnabled()) this.log(`Deleted thread ${name}`)
    return {deleted: name}
  }

  private show(name: string, t: Thread | null): unknown {
    if (!t) this.error(`No thread "${name}".`)
    if (this.jsonEnabled()) return t
    this.log(`Thread ${t.id}  (${t.model})`)
    this.log(`Created: ${t.created_at}`)
    this.log(`Updated: ${t.updated_at}`)
    if (t.system) this.log(`---\nsystem: ${t.system}`)
    for (const m of t.messages) this.log(`---\n${m.role} [${m.ts}]:\n${m.content}`)
    return t
  }
}
