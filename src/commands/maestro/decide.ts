import {Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {HwAPIError, missingFieldsNote} from '../../client.js'
import {
  DECISION_MODELS,
  decisionModels,
  DECISION_FORMATS,
  fromOpenAIAnswers,
  toOpenAIDecision,
  questionsProblem,
  MAX_WARM_UP_WAIT_S,
  QUESTION_TYPES,
  decisionLines,
  heldDecisionError,
  readStateFlags,
  readQuestionFlags,
  warmUpWait,
} from '../../decisions.js'
import {compileHint, sayWarmUp} from '../../utils.js'
import {maestroModel, parseModel} from '../../model.js'

/** What /v1/decisions answers with `weigh`. */
export interface WeighResponse {
  answers?: Array<{probabilities?: Array<{value?: string; probability?: number}>; choice?: string}>
  decision_ids?: Record<string, string>
  weigh?: {premise?: string; kind?: string; cutoff?: number; edges?: Array<{id?: string; p?: number}>;
    pruned?: string[]; side_node?: string; written?: boolean; decision?: string; reason?: string}
}

/** A weighing decision as lines a person reads. */
export function weighLines(data: WeighResponse): string[] {
  const w = data.weigh ?? {}
  if (!w.written) return [`Nothing was written: ${w.reason ?? 'the decision gave no weights'}.`]
  const lines = [`${w.premise ?? '?'}: its ${w.kind ?? '?'} edges, weighed by ${w.decision ?? 'the decision'}`]
  for (const e of w.edges ?? []) {
    const p = typeof e.p === 'number' ? e.p : 0
    const pruned = (w.pruned ?? []).includes(e.id ?? '') ? '   pruned' : ''
    lines.push(`  ${String(Math.round(p * 100) / 100).padEnd(5)} ${e.id ?? '?'}${pruned}`)
  }
  if ((w.pruned ?? []).length > 0) {
    lines.push('', `Pruned (set invalidated): the alternatives outside ${w.cutoff ?? 0.85} of the probability.`)
  }
  lines.push(`side node: ${w.side_node ?? '-'}`)
  return lines
}

/** Decision models served on /v1/decisions in OpenAI's format and refused on /v1/systemone. */
const OPENAI_FORMAT_ONLY = ['gpt-6-luna'] as const

export default class MaestroDecide extends BaseCommand {
  static description =
    'Ask what a face would decide. Stateless: describe a situation, ask typed questions about it, and get back ' +
    'numbers, as this face: a yes-or-no (noul), a pick between options (choice), or a place on a graded scale ' +
    '(score). maestro:choices gives you the options a face would weigh; this gives you what it would decide, for ' +
    'routing, simulations or panels. --face names the face; it runs on maestro-1 (--fast: maestro-1-fast), and ' +
    '--decoder names the decision model that answers (default jev-latest). The face steers the decision model\'s ' +
    'answer. In a state, use state:decide. An answer takes about 10 to 20 seconds; one that runs long is held open ' +
    'by the server and can take a minute or more. The steering is billed per input token plus a small fee per ' +
    'call (see hwai models:list --kind upstream), and the decision model at its listed price. A face needs ' +
    'something compiled.'

  static examples = [
    '<%= config.bin %> <%= command.id %> --face @alice --state "A colleague asks you to sign a grant proposal you have not read, due in an hour." ' +
      '--question "Does the speaker sign?" --option yes="signs it as asked" --option no="declines to sign" ' +
      '--option later="asks for time to read it first"',
    '<%= config.bin %> <%= command.id %> --face @alice --state-file situation.txt --question "Is the speaker irritated?"',
    '<%= config.bin %> <%= command.id %> --face @alice --fast --decoder clef --state-file situation.txt --question "How firm is the reply?" ' +
      '--level yields --level hedges --level firm',
    '<%= config.bin %> <%= command.id %> --face "(@alice | @bob)" --state-file situation.json --questions-file questions.json --json',
    '<%= config.bin %> <%= command.id %> --face @alice:maestro-1/gpt-6-luna --state-file situation.txt --questions-file questions.json',
  ]

  static flags = {
    ...BaseCommand.baseFlags,
    face: Flags.string({
      description:
        'The face: @alice, @owner~alice for one shared with you, or a composite such as "(@a | @b)" (operators | & - ^). ' +
        'The full model, @owner~face:maestro-1/jev-latest, is accepted too.',
      required: true,
    }),
    fast: Flags.boolean({description: 'Run on maestro-1-fast: sooner, and 10 times the price.', default: false}),
    decoder: Flags.string({
      description:
        'The decision model that answers: jev-latest (the default), clef, clef-flash or gpt-6-luna today (hwai models:list ' +
        '--kind decision). gpt-6-luna answers in OpenAI\'s format only, so it uses --format openai.',
    }),
    state: Flags.string({
      description:
        'The situation the face is responding to, as plain text, up to 60,000 characters. Write it the way ' +
        'the face would hear it: it is read as the turn the face is answering.',
      exclusive: ['state-file'],
    }),
    'state-file': Flags.string({
      description:
        'Read the situation from this file instead of --state. A .json file is sent as the JSON it holds, ' +
        'so the situation can be an object or an array.',
      exclusive: ['state'],
    }),
    question: Flags.string({
      description:
        'One question to ask. Its type follows from what comes with it: --option makes it a choice, --level a ' +
        'score, and neither a yes-or-no (noul). For several questions, use --questions-file.',
      exclusive: ['questions-file'],
    }),
    type: Flags.string({
      description: 'The type of --question, when you would rather say it than leave it to --option and --level.',
      options: [...QUESTION_TYPES],
      dependsOn: ['question'],
    }),
    option: Flags.string({
      description:
        'An option for a choice, as name="description", or a bare name (repeatable, at least two). The name is ' +
        'what comes back; the description is what the answer is judged against, so make it specific: ' +
        '"declines to sign", not "no". Keep the options mutually exclusive, because the probability is split ' +
        'between them.',
      multiple: true,
      dependsOn: ['question'],
      exclusive: ['level'],
    }),
    level: Flags.string({
      description:
        'A level of a score, described (repeatable, 2 to 10, lowest first). The answer is the expected level, ' +
        'from 0 for the first to one less than the number of levels.',
      multiple: true,
      dependsOn: ['question'],
      exclusive: ['option'],
    }),
    id: Flags.string({
      // No oclif default: one would count as given, and trip dependsOn on
      // every --questions-file call.
      description: 'Key for the --question in the result (default: answer)',
      dependsOn: ['question'],
    }),
    'questions-file': Flags.string({
      description:
        'A JSON file of 1 to 32 questions, in the API\'s own shape: {"<id>": {"type": "noul" | "choice" | ' +
        '"score", "instructions": "...", "criteria": ...}}. A choice\'s criteria are {"<option>": ' +
        '"<description>" or null}; a score\'s are a list of 2 to 10 levels, lowest first; a noul\'s are optional, ' +
        '{"true": "...", "false": "..."}.',
      exclusive: ['question'],
    }),
    format: Flags.string({
      description:
        'The request shape: systemone (default, TypeSafe Jev\'s System One) or openai (OpenAI\'s Decisions ' +
        'format). The answers are the same; --json returns the chosen format\'s own shape.',
      options: [...DECISION_FORMATS],
      default: 'systemone',
    }),
    retry: Flags.boolean({
      description:
        'If the server answers 503 with the seconds to wait, wait exactly that and ask again, for up to ' +
        `${MAX_WARM_UP_WAIT_S / 60} minutes in all. On by default; --no-retry returns the 503 straight away.`,
      default: true,
      allowNo: true,
    }),
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(MaestroDecide)
    const client = this.makeClient(flags)
    const json = this.jsonEnabled()

    const given = parseModel(flags.face)
    const full = given.upstream !== undefined && given.downstream !== undefined
    const {model: named, problem} = maestroModel(flags.face, {fast: flags.fast, decoder: full ? flags.decoder : (flags.decoder ?? 'jev-latest'), needsDecoder: true})
    if (problem || !named) this.error(problem ?? 'Name the face.')
    const name = parseModel(named)
    const face = name.faces as string
    let downstream = name.downstream as string

    const state = this.readState(flags)
    if (state === undefined) this.error('Describe the situation: --state "..." or --state-file. In a state, use state:decide.')
    const questions = this.readQuestions(flags)
    if (!questions) this.error('Ask at least one question, with --question or --questions-file.')
    const openaiOnly = (OPENAI_FORMAT_ONLY as readonly string[]).includes(downstream.toLowerCase())
    const problemQ = questionsProblem(questions, true, openaiOnly)
    if (problemQ) this.error(problemQ)
    this.models = await decisionModels(client)
    // The server matches the id exactly, so send the catalog's spelling.
    const match = this.models.find((m) => m.toLowerCase() === downstream.toLowerCase())
    if (!match) this.error(`'${downstream}' is not a decision model. The decision models are: ${this.models.join(', ')}.`)
    downstream = match
    // OpenAI's Decisions model is served only in OpenAI's format.
    if ((OPENAI_FORMAT_ONLY as readonly string[]).includes(match)) {
      if (this.argv.some((a) => a === '--format=systemone' || a === 'systemone')) {
        this.error(`${match} answers in OpenAI's format only. Use --format openai, or leave --format out.`)
      }
      flags.format = 'openai'
    }

    const model = `${name.upstream}/${downstream}`
    let body: Record<string, unknown> = state === undefined ? {model, questions} : {model, state, questions}
    if (flags.format === 'openai') {
      try {
        body = toOpenAIDecision(model, state, questions)
      } catch (err) {
        this.error(err instanceof Error ? err.message : String(err))
      }
    }

    if (!json) {
      process.stderr.write(`Asking ${face}. Decision model: ${downstream}. This usually takes 10 to 20 seconds, sometimes a minute or more.\n`)
    }

    let data: {answers?: Record<string, unknown>; decision_ids?: Record<string, string>}
    try {
      data = (await this.ask(client, body, flags.retry, json, flags.format === 'openai' ? '/v1/decisions' : '/v1/systemone')) as typeof data
    } catch (err) {
      if (err instanceof HwAPIError) this.error(this.explain(err, face, downstream))
      throw err
    }

    // Say plainly when a field this relies on is missing, rather than printing
    // an empty line: the API renames fields as it goes, and the fix is usually
    // an update.
    const missing = missingFieldsNote(data, ['answers'])
    if (missing) process.stderr.write(`${missing}\n`)

    if (json) return data
    const answers = flags.format === 'openai' ? fromOpenAIAnswers(data.answers, questions) : (data.answers ?? {})
    for (const line of decisionLines(answers)) this.log(line)
    const ids = Object.entries(data.decision_ids ?? {})
    if (ids.length > 0) {
      this.log('')
      for (const [q, id] of ids) this.log(`decision id (${q}): ${id}`)
    }
    return data
  }

  /**
   * Send the request, and if the server answers 503 naming a wait, wait that
   * long and ask again.
   *
   * Such a refusal comes before any work, so asking again costs nothing, and
   * the wait is the server's number exactly. Anything else, including a 503
   * that names no wait, goes straight back to the caller.
   */
  private async ask(
    client: ReturnType<typeof this.makeClient>,
    body: Record<string, unknown>,
    retry: boolean,
    json: boolean,
    endpoint: string,
  ): Promise<unknown> {
    let waited = 0
    for (;;) {
      try {
        // Jev's System One format (`state`, questions keyed by id) is served at /v1/systemone,
        // and OpenAI's Decisions format at /v1/decisions; each refuses the other with a 422.
        //
        // No client timeout is set, and none may be under 60s: a slow decision
        // is held open past 40s with keep-alive spaces before its JSON, and
        // Node's own limits (300s for the headers, 300s between body bytes)
        // are reset by every one of them.
        const data = await client.post(endpoint, {body})
        // A held call that failed is a 200 carrying the refusal.
        const held = heldDecisionError(data)
        if (held) throw held
        return data
      } catch (err) {
        if (!(err instanceof HwAPIError) || !retry || err.retryable === false) throw err
        const wait = warmUpWait(err.statusCode, err.retryAfter, waited)
        if (wait === undefined) throw err
        if (!json) sayWarmUp(wait)
        await new Promise((r) => setTimeout(r, wait * 1000))
        waited += wait
      }
    }
  }

  private readState(flags: {state?: string; 'state-file'?: string}): unknown {
    return readStateFlags(flags, (m) => this.error(m))
  }

  private readQuestions(flags: {
    question?: string
    type?: string
    option?: string[]
    level?: string[]
    id?: string
    'questions-file'?: string
  }): Record<string, unknown> | undefined {
    return readQuestionFlags(flags, (m) => this.error(m))
  }

  private models?: string[]

  /** The refusal, with what to do about it. */
  private explain(err: HwAPIError, face: string, model: string): string {
    const head = `HTTP ${err.statusCode}: ${err.message}`
    switch (err.statusCode) {
      case 409: {
        // Nothing compiled at all wants a first source, not a recompile.
        return `${head}\n${compileHint(face.replace(/^@/, '').replace('~', ':'), !/nothing compiled/i.test(err.message), 'decide')}`
      }

      case 503: {
        // With a wait named, the retry gave up on it or was told not to wait
        // it out. Without one, the decision model failed; that may pass.
        if (err.retryAfter !== undefined) return `${head}\nTry again in ${err.retryAfter}s.`
        const others = (this.models ?? [...DECISION_MODELS]).filter((m) => m !== model).join(', ')
        return `${head}\nTry again. If the message names the decision model, another decision model may answer (${others}).`
      }

      case 504: {
        return `${head}\nThe face did not finish within 300 seconds. Ask again.`
      }

      default: {
        return head
      }
    }
  }
}
