import {Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {ReplyCommand, stateIdFlag} from '../../foreman.js'
import {HwAPIError} from '../../client.js'
import {CONVERSATIONS_PATH, conversationHint} from '../../conversation.js'
import {seg} from '../../utils.js'

export default class StateClose extends ReplyCommand {
  static description =
    'Close a state. A closed state takes no more turns and cannot be read or compacted. Its ' +
    'compactions stay usable until they expire. Free.'

  static examples = ['<%= config.bin %> <%= command.id %> --yes']

  static flags = {
    ...BaseCommand.baseFlags,
    ...stateIdFlag,
    yes: Flags.boolean({description: 'Skip confirmation', default: false}),
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(StateClose)
    const stateId = this.stateId(flags)
    const client = this.makeClient(flags)
    await this.confirmOrRefuse(`Close state ${stateId}? It cannot be reopened.`, flags.yes)

    let data: unknown
    try {
      data = await client.delete(`${CONVERSATIONS_PATH}/${seg(stateId)}`)
    } catch (err) {
      if (err instanceof HwAPIError) {
        const hint = conversationHint(err)
        this.error(`HTTP ${err.statusCode}: ${err.message}${hint ? `\n${hint}` : ''}`)
      }
      throw err
    }

    if (!this.jsonEnabled()) this.log(`Closed state ${stateId}.`)
    return data
  }
}
