import {Flags} from '@oclif/core'
import fs from 'node:fs'
import {BaseCommand} from './base.js'
import {HwAPIError, HwClient} from './client.js'
import {chatgptLinked} from './style.js'
import {
  chatFlags,
  CHAT_COMPLETIONS_ENDPOINT,
  RESPONSES_ENDPOINT,
  chatMeta,
  chatModelProblem,
  chatPayload,
  sendChat,
  type Turn,
} from './chat.js'
import {maestroModel, parseModel} from './model.js'
import {resolveEndpoint} from './routing.js'
import {faceRefusalHint, parseTemperature} from './utils.js'

/** The chat flags without the state ones: maestro:chat is stateless. */
export function statelessChatFlags() {
  const {conversation: _c, premise: _p, 'premise-description': _pd, 'premise-status': _ps, 'premise-depends-on': _pdo,
    'premise-role': _pr, 'premise-origin': _po, 'causes-visible': _cv, session: _s, compaction: _cm, ...rest} = chatFlags()
  return {
    face: Flags.string({
      description:
        'The face: @alice, @owner~alice for one shared with you, or a composite such as "(@a | @b)" (operators | & - ^). ' +
        'The full model, @owner~face:maestro-1/<decoder>, is accepted too. Needed unless going on with a --thread.',
    }),
    flash: Flags.boolean({description: 'Steer with maestro-1-flash: sooner, at 10 times the steering price.', default: false}),
    decoder: Flags.string({description: 'The chat model that writes the reply, any chat model in hw models:list, written as it is listed (e.g. gpt-5.4).'}),
    ...rest,
  }
}

/** What maestro:chat runs; the subclass names its endpoint. */
export abstract class ChatCommand extends BaseCommand {
  static flags = {
    ...BaseCommand.baseFlags,
    ...statelessChatFlags(),
  }

  /** The endpoint this command always uses, or undefined to route from the catalog. */
  protected abstract forcedEndpoint(flags: Record<string, unknown>): string | undefined

  async run(): Promise<unknown> {
    const {flags} = await this.parse(this.constructor as typeof ChatCommand)
    const client = this.makeClient(flags)
    const json = this.jsonEnabled()

    const named = maestroModel(flags.face ?? '', {flash: flags.flash, decoder: flags.decoder, needsDecoder: true})
    if (named.problem || !named.model) this.error(named.problem ?? 'Name the face.')
    const model = named.model
    const problem = chatModelProblem(model)
    if (problem) this.error(problem)

    const turns: Turn[] = []
    if (flags.file) {
      if (!fs.existsSync(flags.file)) this.error(`File not found: ${flags.file}`)
      turns.push({role: 'user', content: fs.readFileSync(flags.file, 'utf8')})
    }
    for (const m of flags.message ?? []) turns.push({role: 'user', content: m})
    if (turns.length === 0) this.error('Provide at least one --message/-m or --file.')

    const downstream = parseModel(model).downstream as string
    const route = await resolveEndpoint(client, downstream)
    const endpoint = this.forcedEndpoint(flags) ?? route.endpoint
    const temperature = flags.temperature === undefined ? undefined : parseTemperature(flags.temperature, (m) => this.error(m))

    let payload: Record<string, unknown>
    try {
      payload = chatPayload(endpoint, model, turns, {
        system: flags.system,
        maxTokens: flags['max-tokens'],
        temperature,
        // --json wants the whole body and its cost headers.
        stream: flags.stream && !json,
        oauthOnly: flags['oauth-only'],
      })
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err))
    }

    try {
      const res = await sendChat(client, endpoint, payload, (d) => process.stdout.write(d), json)
      if (payload.stream) {
        if (!res.text) this.error('The reply stream ended with no answer. Run it again with --no-stream to see what the server said.')
        process.stdout.write('\n')
        return {}
      }
      if (json) {
        const body = res.body ?? {}
        body._meta = chatMeta(res.headers ?? {}, endpoint, model)
        return body
      }
      this.log(res.text)
      return res.body
    } catch (err) {
      if (err instanceof HwAPIError) this.error(await chatRefusal(err, model, endpoint, route.freeWhenConnected, client))
      throw err
    }
  }
}

/** A chat refusal, with what to do about it. */
export async function chatRefusal(err: HwAPIError, model: string, endpoint: string, freeWhenConnected: boolean, client: HwClient): Promise<string> {
  if (err.errorCode === 'oauth_rejected') {
    const hints: string[] = []
    const linked = await chatgptLinked(client)
    if (linked === false) hints.push('No ChatGPT account is linked. Link one with: hw auth:connect openai')
    else hints.push('If the ChatGPT link has lapsed, link it again with: hw auth:connect openai')
    if (endpoint === RESPONSES_ENDPOINT && freeWhenConnected && linked === false) hints.push('This model is free once it is linked.')
    hints.push(
      err.fallbackAvailable
        ? 'Or allow paid fallback: hw account:preferences api_fallback true'
        : 'Or add credits (hw billing:topup --amount <usd>) and allow paid fallback: hw account:preferences api_fallback true',
    )
    return `OAuth failed: ${err.message}\n${hints.join('\n')}`
  }
  if (err.errorCode === 'model_not_supported') {
    return `${err.message}\nYour ChatGPT plan does not serve this model. Name another after the /, or let it run on credits: hw account:preferences api_fallback true`
  }
  if (err.errorCode === 'use_responses_for_free_oauth' && endpoint === CHAT_COMPLETIONS_ENDPOINT) {
    return `HTTP ${err.statusCode}: ${err.message}\nRun it on your ChatGPT plan with --responses.`
  }
  const hint = faceRefusalHint(err, model)
  return `HTTP ${err.statusCode}: ${err.message}${hint ? `\n${hint}` : ''}`
}
