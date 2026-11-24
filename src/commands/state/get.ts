import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {ReplyCommand, formatFlags, formatOf, stateIdFlag} from '../../foreman.js'

export default class StateGet extends ReplyCommand {
  static description =
    'Read a state. With no key, the whole proof: one line per premise, numbered (1, 1.2, 1.2.1), [x] proved, ' +
    '[ ] open, [-] refuted, the operator on each parent, candidates highest p first; then the last line: proved, ' +
    'refuted or open, the next candidate to try, and what would prove it. With a key, that premise and its ' +
    'branch, numbered the same way, then every message linked to it in full (what the human said, notes, ' +
    'evidence): --depth N levels (default all), --up the path from its root down to it. --query: the premises ' +
    'that best match a text, by meaning (limited to the branch when a key is given). Free.'

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --query "dietary needs"',
    '<%= config.bin %> <%= command.id %> --problog > proof.pl',
    '<%= config.bin %> <%= command.id %> "the dinner is planned" --depth 2',
    '<%= config.bin %> <%= command.id %> "the menu" --up',
    '<%= config.bin %> <%= command.id %> "the menu" --query "allergies"',
  ]

  static flags = {
    ...BaseCommand.baseFlags,
    ...stateIdFlag,
    ...formatFlags,
    query: Flags.string({description: 'The premises that best match this text, by meaning (in the key\'s branch when a key is given).'}),
    depth: Flags.integer({description: 'With a key: how many levels below it, 0 to 50. Default: all.', min: 0, max: 50}),
    up: Flags.boolean({description: 'With a key: the path from its root down to it, instead of its branch.', default: false}),
    all: Flags.boolean({description: 'Also premises pruned by an earlier version.', default: false}),
  }

  static args = {key: Args.string({description: 'A premise. Left out, the whole proof.', required: false})}

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(StateGet)
    const client = this.makeClient(flags)
    const key = args.key
    if (key === undefined && (flags.depth !== undefined || flags.up)) this.error('--depth and --up read one premise\'s branch: name the premise.')
    const params: Record<string, string> = key === undefined ? {} : {key}
    params.format = formatOf(flags, this.jsonEnabled())
    if (flags.depth !== undefined) params.depth = String(flags.depth)
    if (flags.up) params.up = 'true'
    if (flags.query) params.query = flags.query
    if (flags.all) params.all = 'true'
    return this.reply(client, 'GET', this.statePath(this.stateId(flags), key === undefined ? '/proof' : '/premise'), {params})
  }
}
