import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {HwAPIError} from '../../client.js'
import {seg} from '../../utils.js'

export default class BillingCardRemove extends BaseCommand {
  static description =
    'Remove a saved card. Removing the default makes the newest other card the default. The last card ' +
    'cannot be removed while a paid subscription renews on it.'

  static examples = ['<%= config.bin %> <%= command.id %> pm_EXAMPLE --yes']

  static flags = {
    ...BaseCommand.baseFlags,
    yes: Flags.boolean({description: 'Skip confirmation', default: false}),
  }

  static args = {
    card_id: Args.string({description: 'Card id (pm_...), from hw account:cards', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(BillingCardRemove)
    const client = this.makeClient(flags)

    await this.confirmOrRefuse(`Remove card ${args.card_id}?`, flags.yes)

    let data: unknown
    try {
      data = await client.delete(`/v1/billing/payment-methods/${seg(args.card_id)}`, {requireJwt: true})
    } catch (err) {
      if (err instanceof HwAPIError) {
        if (err.statusCode === 404) this.error(`HTTP 404: ${err.message}\nList your cards with: hw account:cards`)
        if (err.statusCode === 409) {
          this.error(
            `HTTP 409: ${err.message}\n` +
              'Add another card first (hw account:card-add), or cancel the subscription ' +
              '(hw account:cancel).',
          )
        }
        this.error(`HTTP ${err.statusCode}: ${err.message}`)
      }
      throw err
    }

    if (!this.jsonEnabled()) this.log(`Removed ${args.card_id}. See what is left with: hw account:cards`)
    return data
  }
}
