import {Args, Flags} from '@oclif/core'
import fs from 'node:fs'
import path from 'node:path'
import {BaseCommand} from '../../../base.js'
import {HwAPIError} from '../../../client.js'
import CompileDoc from '../../../compile-doc.js'
import {MEDIUM_MISSING_MESSAGE, MEDIUM_REQUIRED_DESCRIPTION, RUSH_FLAG_DESCRIPTION, documentWarningLines, readTextFile, seg, uploadWarningLines} from '../../../utils.js'
import DocMake from '../doc/make.js'
import ThreadMake from '../thread/make.js'

/** Files the server reads itself: sent as an upload, never read here as text. */
export const UPLOADED_EXTENSIONS = new Set([
  '.pdf', '.docx',
  '.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus',
  '.mp4', '.mov', '.webm', '.mkv', '.m4v',
])

/** Whether a source goes up as a file upload rather than as text. */
export function isUploaded(file: string): boolean {
  return UPLOADED_EXTENSIONS.has(path.extname(file).toLowerCase())
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export default class FaceCompile extends BaseCommand {
  static description =
    'Compile source material into a face, and wait for it to finish. A document (--kind doc, the default) is the ' +
    'face\'s own writing, and every word in it is read as theirs: text files, PDF and Word .docx, or audio and ' +
    'video, which are transcribed first. Repeat --file for several text documents; each becomes its own document. ' +
    'An interview, transcript or dialogue is a thread: --kind thread --face-speaker NAME, so only the face\'s ' +
    'turns are used. A compile may have a scheduled start: it says when, and waits for it; --rush starts it as ' +
    'soon as possible, at the rush rate only if it starts before that scheduled start, and --no-wait returns at ' +
    'once. A face runs at most 3 compiles at once, rushed or not; more wait their turn.'

  static examples = [
    '<%= config.bin %> <%= command.id %> alice --file essay.txt --medium essay',
    '<%= config.bin %> <%= command.id %> alice --file a.txt --file b.txt --medium "blog post" --no-wait --json',
    '<%= config.bin %> <%= command.id %> alice --file talk.pdf --medium essay',
    '<%= config.bin %> <%= command.id %> alice --file interview.txt --kind thread --face-speaker Alice --rush',
  ]

  static flags = {
    ...BaseCommand.baseFlags,
    file: Flags.string({description: 'The source file (repeatable for text documents; each becomes its own document).', multiple: true}),
    content: Flags.string({description: 'Inline text, as a document.', exclusive: ['file']}),
    kind: Flags.string({
      description:
        'doc: the face\'s own writing (or, with --perspective third-person, writing about them). thread: an ' +
        'exchange between speakers (an interview, transcript or dialogue), with --face-speaker naming the face. ' +
        'A transcript compiled as a doc is read as entirely the face\'s words.',
      options: ['doc', 'thread'],
      default: 'doc',
    }),
    'face-speaker': Flags.string({
      description:
        'With --kind thread: the speaker who is the face, as labelled in the file ("Alice" for "Alice: ..." lines, ' +
        'or "A" for a recording). Only that speaker\'s turns are used. If omitted, the speaker matching the face\'s ' +
        'name is used, or else the first speaker, so set it to be sure.',
    }),
    medium: Flags.string({description: `${MEDIUM_REQUIRED_DESCRIPTION} Required with --kind doc, and only valid with it.`}),
    perspective: Flags.string({
      description:
        'With --kind doc: who wrote it. first-person (default) means the subject did; third-person means it is ' +
        'ABOUT them. Third-person material compiles, but never goes into a style.',
      options: ['first-person', 'third-person'],
      default: 'first-person',
    }),
    label: Flags.string({description: 'A label for a single text document (several files are labelled by their filenames).'}),
    rush: Flags.boolean({description: RUSH_FLAG_DESCRIPTION, default: false}),
    timeout: Flags.integer({description: 'Compile timeout in seconds, per source, counted from its start', default: 600}),
    'no-wait': Flags.boolean({description: 'Return once the compile is started, without waiting for it.', default: false}),
  }

  static args = {
    alias: Args.string({description: 'The face alias', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(FaceCompile)
    const files = flags.file ?? []
    const thread = flags.kind === 'thread'

    if (thread) {
      if (flags.medium) this.error('--medium applies to --kind doc only; a thread carries a kind per message.')
      if (flags.content !== undefined) this.error('--content is a document. A thread comes from a file: --file FILE --kind thread.')
      if (files.length !== 1) this.error('A thread is compiled from one file: --file FILE --kind thread.')
    } else {
      if (flags['face-speaker']) this.error('--face-speaker applies to --kind thread only.')
      if (!flags.medium) this.error(MEDIUM_MISSING_MESSAGE)
    }

    // Shared by every delegated call: where to send it and as whom.
    const pass: string[] = []
    if (flags['base-url']) pass.push('--base-url', flags['base-url'])
    if (flags.token) pass.push('--token', flags.token)
    if (flags['api-key']) pass.push('--api-key', flags['api-key'])
    if (this.jsonEnabled()) pass.push('--json')
    if (flags.toon) pass.push('--toon')
    const compile = ['--timeout', String(flags.timeout), ...(flags.rush ? ['--rush'] : []), ...(flags['no-wait'] ? ['--no-wait'] : [])]

    // Text documents, one or many: created and compiled one after another.
    if (!thread && !files.some(isUploaded)) {
      const argv = [args.alias, ...files.flatMap((f) => ['--file', f])]
      if (flags.content !== undefined) argv.push('--content', flags.content)
      argv.push('--medium', flags.medium as string, '--perspective', flags.perspective)
      if (flags.label) argv.push('--label', flags.label)
      await CompileDoc.run([...argv, ...compile, ...pass], this.config)
      return undefined
    }

    if (files.length !== 1) this.error('A PDF, Word, audio or video file is compiled one at a time: one --file per call.')
    const id = await this.upload(args.alias, files[0], thread, flags)
    const Make = thread ? ThreadMake : DocMake
    await Make.run([id, ...compile, ...pass], this.config)
    return undefined
  }

  /** Send the file to the face's upload route, wait out any transcription, and return the new source's id. */
  private async upload(
    alias: string,
    file: string,
    thread: boolean,
    flags: {medium?: string; perspective: string; 'face-speaker'?: string; 'base-url'?: string; token?: string; 'api-key'?: string},
  ): Promise<string> {
    const client = this.makeClient(flags)
    const json = this.jsonEnabled()
    if (!fs.existsSync(file)) this.error(`File not found: ${file}`)

    // Plain text, for the transcript check on an older server that does not say whether a document reads as one.
    let text: string | undefined
    if (!thread && !isUploaded(file)) {
      try {
        text = readTextFile(file)
      } catch {
        // not plain text
      }
    }

    const form = new FormData()
    form.append('file', new Blob([fs.readFileSync(file)], {type: 'application/octet-stream'}), path.basename(file))
    const params = new URLSearchParams()
    params.set('type', thread ? 'thread' : 'document')
    if (!thread && flags.medium) params.set('medium', flags.medium)
    params.set('perspective', flags.perspective)
    if (flags['face-speaker']) params.set('face_speaker', flags['face-speaker'])

    let data: Record<string, unknown>
    try {
      if (!json) process.stderr.write(`Uploading ${path.basename(file)}... `)
      data = (await client.postForm(`/v1/faces/${seg(alias)}/upload?${params}`, form)) as Record<string, unknown>
      if (!json) process.stderr.write('done\n')
    } catch (err) {
      if (!json) process.stderr.write('failed\n')
      if (err instanceof HwAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    if (!thread) for (const line of documentWarningLines(data, text, alias, file)) process.stderr.write(`${line}\n`)

    const id = String((thread ? data.thread_id : data.document_id) ?? '')
    if (!id) this.error('The server did not return the new source\'s id.')

    if (data.status === 'transcribing') {
      const route = thread ? `/v1/compile/threads/${seg(id)}` : `/v1/compile/documents/${seg(id)}`
      if (!json) process.stderr.write('Transcribing...\n')
      const start = Date.now()
      while (Date.now() - start < 3600_000) {
        await sleep(5000)
        try {
          const poll = (await client.get(route)) as Record<string, unknown>
          if (poll.status !== 'transcribing') {
            if (poll.status === 'failed') this.error(`Transcription failed. The source is kept: hw face:${thread ? 'thread' : 'doc'}:get ${id}`)
            data = poll
            if (!json) process.stderr.write(`Transcription complete${thread ? `: ${poll.message_count ?? 0} messages` : ''}\n`)
            break
          }
          if (!json) process.stderr.write('Transcribing...\n')
        } catch (err) {
          if (err instanceof Error && 'oclif' in err) throw err
          // a transient error: keep polling
        }
      }
    }

    // A 200 says nothing about what was dropped: say it.
    if (thread && !json) for (const line of uploadWarningLines(data)) process.stderr.write(`${line}\n`)
    return id
  }
}
