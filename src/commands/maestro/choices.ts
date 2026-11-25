import {Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {HwAPIError} from '../../client.js'
import {CHOICES_PATH, MAX_CHOICES, choicesHint, choicesLines, type ChoicesResponse} from '../../choices.js'
import {CHOICES_DECODER, maestroModel, parseModel} from '../../model.js'
import {heldDecisionError, readStateFlags} from '../../decisions.js'
import {retryOnceOnWarmUp, sayWarmUp} from '../../utils.js'

export default class MaestroChoices extends BaseCommand {
  static description =
    'Ask a face what it would do (POST /v1/choices). Stateless: describe the situation with --state (prose, at ' +
    'most 3,000 tokens) or --state-file, ask with --question, and the face proposes the options it would weigh, ' +
    'strongest first. Leave --question out and it proposes the question it would ask. --face names the face ' +
    '(@alice, @owner~alice for one shared with you, or a composite such as "(@alice | @bob)"); it runs on ' +
    'maestro-1, or maestro-1-fast with --fast, which answers sooner and costs 10 times more. ' +
    'In a state, use state:choices. Billed on the tokens it processes (see hw models:list --kind upstream). ' +
    'Takes about 10 to 30 seconds.'

  static examples = [
    '<%= config.bin %> <%= command.id %> --face @alice --state "A startup offers me a lead role at a lower salary." --question "Should I take the offer?"',
    '<%= config.bin %> <%= command.id %> --face @head~socrates --state "A chain bakery opened across the street."',
    '<%= config.bin %> <%= command.id %> --face "(@alice | @bob)" --fast --state-file situation.txt -q "What next?" --json',
    '<%= config.bin %> <%= command.id %> --face @alice:maestro-1/choices --state "The lease is up in March." --max-choices 3',
  ]

  static flags = {
    ...BaseCommand.baseFlags,
    face: Flags.string({
      description:
        'The face: @alice, @owner~alice for one shared with you, or a composite such as "(@a | @b)" (operators | & - ^). ' +
        'The full model, @owner~face:maestro-1/choices, is accepted too.',
      required: true,
    }),
    fast: Flags.boolean({description: 'Run on maestro-1-fast: sooner, and 10 times the price.', default: false}),
    question: Flags.string({char: 'q', description: 'The question. Leave it out to have the face propose the question it would ask.'}),
    state: Flags.string({description: 'The situation, as prose: at most 3,000 tokens.', exclusive: ['state-file']}),
    'state-file': Flags.string({description: 'Read the situation from this file.', exclusive: ['state']}),
    'max-choices': Flags.integer({description: `The most options to return, 1 to ${MAX_CHOICES}. Default 8.`, min: 1, max: MAX_CHOICES}),
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(MaestroChoices)
    const client = this.makeClient(flags)
    const json = this.jsonEnabled()
    // The model string names the face, the encoder and the decoder: `@alice:maestro-1/choices`
    const named = parseModel(flags.face)
    if (named.upstream && named.downstream && named.downstream.toLowerCase() !== CHOICES_DECODER) {
      this.error(`maestro:choices runs the ${CHOICES_DECODER} decoder: --face ${named.upstream}/${CHOICES_DECODER}, or the face alone.`)
    }
    const {model, problem} = maestroModel(flags.face, {fast: flags.fast, decoder: named.upstream && named.downstream ? undefined : CHOICES_DECODER, needsDecoder: true})
    if (problem || !model) this.error(problem ?? 'Name the face.')

    const body: Record<string, unknown> = {model}
    const fail = (m: string): never => this.error(m)
    if (flags.state !== undefined || flags['state-file'] !== undefined) {
      const state = readStateFlags(flags, fail)
      if (typeof state === 'string' && state.trim() === '') this.error('The situation is empty.')
      body.state = state
    }
    if (body.state === undefined) this.error('Describe the situation: --state "..." (or --state-file). In a state, use state:choices.')
    if (flags.question !== undefined) {
      if (flags.question.trim() === '') this.error('--question is empty. Leave it out to have the face propose the question.')
      body.instructions = flags.question
    }
    if (flags['max-choices'] !== undefined) body.max_choices = flags['max-choices']

    let data: ChoicesResponse
    try {
      data = (await retryOnceOnWarmUp(async () => {
        const res = await client.post(CHOICES_PATH, {body})
        const held = heldDecisionError(res)
        if (held) throw held
        return res
      }, json ? undefined : sayWarmUp)) as ChoicesResponse
    } catch (err) {
      if (err instanceof HwAPIError) {
        const hint = choicesHint(err.statusCode, err.message, model)
        this.error(`HTTP ${err.statusCode}: ${err.message}${hint ? `\n${hint}` : ''}`)
      }
      throw err
    }

    if (json) return data
    for (const line of choicesLines(data)) this.log(line)
    return data
  }
}
