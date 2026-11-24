import {Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {MESSAGES_ENDPOINT, RESPONSES_ENDPOINT} from '../../chat.js'
import {ChatCommand, statelessChatFlags} from '../../chat-command.js'

export default class MaestroChat extends ChatCommand {
  static description =
    'Chat with a face. Stateless: --face names the face, which steers on maestro-1 (--flash: maestro-1-flash), and ' +
    '--decoder names the chat model that writes the reply. Routes to /v1/chat/completions, /v1/responses or ' +
    '/v1/messages from the model catalog; --responses or --messages picks the format whatever the model. The ' +
    'face\'s style is chosen for each request. The steering is billed per input token plus a small fee per call ' +
    '(hw models:list --kind upstream), and the decoder at its listed price.'

  static examples = [
    '<%= config.bin %> <%= command.id %> --face @socrates --decoder gpt-5.4 -m "What is virtue?"',
    '<%= config.bin %> <%= command.id %> --face @head~socrates --flash --decoder claude-sonnet-4-6 -m "What is virtue?"',
    '<%= config.bin %> <%= command.id %> --face "(@socrates | @nietzsche)" --decoder gpt-5.4 -m "What is virtue?"',
    '<%= config.bin %> <%= command.id %> --face @socrates:maestro-1/gpt-5.4 --messages -m "What is virtue?"',
  ]

  static flags = {
    ...BaseCommand.baseFlags,
    ...statelessChatFlags(),
    responses: Flags.boolean({description: 'Send it to /v1/responses whatever the catalog says (routing is automatic otherwise).', default: false, exclusive: ['messages']}),
    messages: Flags.boolean({description: 'Send it to /v1/messages, in the Messages format. Not every decoder is served there; a refusal names the route to use.', default: false, exclusive: ['responses']}),
  }

  protected forcedEndpoint(flags: Record<string, unknown>): string | undefined {
    if (flags.messages) return MESSAGES_ENDPOINT
    return flags.responses ? RESPONSES_ENDPOINT : undefined
  }
}
