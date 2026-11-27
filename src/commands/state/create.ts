import {Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {HwAPIError} from '../../client.js'
import {CONVERSATIONS_PATH, Conversation, conversationHint} from '../../conversation.js'
import {writeStateFile} from '../../foreman.js'
import {seg} from '../../utils.js'

/**
 * state:create: a new, empty state. With --use, this directory uses it: its id goes in
 * .headwaters/state, which every state:* command here or below reads. Then build it
 * with state:add (the older state:create flags are not part of this surface).
 */
export default class StateCreate extends BaseCommand {
  static description =
    'Create a new, empty state: a proof in progress, built with state:add and read with state:get. ' +
    '--use makes this directory use it (.headwaters/state, read by every hwai call here or below). Free. ' +
    'A state expires 30 days after it was last used.'

  static examples = [
    '<%= config.bin %> <%= command.id %> --use',
    '<%= config.bin %> <%= command.id %> --use --local',
    '<%= config.bin %> <%= command.id %>',
  ]

  static flags = {
    ...BaseCommand.baseFlags,
    use: Flags.boolean({description: 'Use it in this directory: write .headwaters/state, which every hwai call here or below reads.', default: false}),
    local: Flags.boolean({description: 'With --use: write .headwaters/state.local instead (overrides .headwaters/state, for you alone).', default: false, dependsOn: ['use']}),
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(StateCreate)
    const client = this.makeClient(flags)
    let data: Conversation
    try {
      data = (await client.post(CONVERSATIONS_PATH, {body: {}})) as Conversation
    } catch (err) {
      if (err instanceof HwAPIError) {
        const hint = conversationHint(err)
        this.error(`HTTP ${err.statusCode}: ${err.message}${hint ? `\n${hint}` : ''}`)
      }
      throw err
    }
    if (!data.id) this.error('The server returned no state id.')
    if (!flags.use) {
      if (this.jsonEnabled()) return data
      this.log(`Created an empty state, ${data.id}. hwai state:use ${data.id} makes this directory use it.`)
      return data
    }
    const file = writeStateFile(data.id, flags.local)
    if (this.jsonEnabled()) return {...data, state_file: file}
    this.log(`Created an empty state, ${data.id}. Every hwai call in this directory now uses it (${file}).`)
    try {
      const got = await client.stateReply('GET', `${CONVERSATIONS_PATH}/${seg(data.id)}/proof`)
      if (typeof got.data.text === 'string') this.log('\n' + got.data.text)
    } catch {
      // the state is created and used; its proof is one hwai state:get away
    }
    return {...data, state_file: file}
  }
}
