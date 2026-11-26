# hw

The Headwaters command line. Compile a **face** from an author's source texts, then ask it, through
**Maestro**, what it would do: it proposes the options it would weigh, strongest first. A face also
steers any chat model's replies, and a decision model's typed decisions. A **state** is a proof in
progress that your agent builds with a face, kept on the server.

Commands are grouped by topic, as `hw topic:command`: `face:*`, `maestro:*` and `state:*`, plus `account:*` and `key:*`.

## Installation

```bash
npm install -g @headwaters-ai/cli
```

Requires Node.js >= 18.

## Quick start

```bash
# Register or log in: you will be asked for your password
hw account:register --email you@example.com --username you
hw account:login --email you@example.com

# Create a face
hw face:create --name "Alice" --alias alice --default-model gpt-5.4-mini \
  --attr gender=woman --attr age=29 --attr occupation="Works as a product designer."

# Compile source texts: her own writing as a document, an interview as a thread
hw face:compile alice --file essay.txt --medium essay
hw face:compile alice --file interview.txt --kind thread --face-speaker Alice

# Ask what it would do: the options it would weigh, strongest first
hw maestro:choices --face @alice --state "A startup offers me a lead role at a lower salary." --question "Should I take the offer?"

# Or let it propose the question it would ask
hw maestro:choices --face @alice --state "A startup offers me a lead role at a lower salary."

# Chat: the face steers, gpt-5.4 writes the reply
hw maestro:chat --face @alice --decoder gpt-5.4 -m "Should I take the offer?"

# Decide: typed answers from a decision model, steered by the face
hw maestro:decide --face @alice --state "A colleague asks you to sign a proposal you have not read." \
  --question "Does the speaker sign?"

# Compare and compose
hw face:diff --face alice --face bob
hw face:create --name "Alice-Bob" --alias alice-bob --formula "alice | bob"
```

## Commands

```
hw account:register / login / logout / whoami / refresh
hw account:connect / disconnect / connections
hw account:balance / topup / usage / llm-costs
hw account:plan / subscription / activate / cancel
hw account:cards / card-add / card-remove / card-default
hw account:preferences / show

hw face:create / list / get / edit / delete / stats / attributes / sources
hw face:diff / neighbors / lock / unlock / publish / unpublish / share / unshare / groups
hw face:compile                   # compile a document or a thread into a face, and wait for it
hw face:compile:all / status / stats
hw face:import                    # a video, downloaded and transcribed on the server
hw face:doc:create / list / get / edit / make / pause / reset / delete
hw face:thread:create / list / get / edit / message / replace / make / pause / reset / delete
hw face:style:upload / make / status / versions / revert / delete
hw face:fidelity:start / turn / pick / get / run / save-thread
hw face:benchmark:start / get / list
hw face:avatar:list / get / make / upload / delete
hw face:tag:add / list / remove / set / all

hw maestro:choices                # what a face would do: its options, or the question it would ask
hw maestro:decide                 # what a face would decide: yes/no, a choice, or a score
hw maestro:chat                   # chat with a face on any chat model; --thread <name> keeps a multi-turn chat

hw state:create --use / use / get # a state for this directory (.headwaters/state) and its proof
hw state:add / edit / delete / claim
hw state:refine / choices / decide # billed: refine a premise with a face, its candidates, their ranking
hw state:items / close           # a state's items in order, closing it
hw state:hud                     # the state in three lines; on / off / auto; --hook for the harness hooks

hw models:list                    # the models you can name; --kind takes a list, or all
hw media:list                     # the media a document can be, with what each covers

hw group:create / list / get / edit / delete / members / add / remove
hw group:tag:add / list / remove / set
hw user:get / follow / unfollow / followers / following

hw catalog:list / doctor / backup / restore

hw key:create / list / edit / revoke

hw config:set / show / clear
```

Run `hw <command> --help` for details on any command. Every command takes `--json`, and
`--toon` for a more compact encoding of the same data.

## Compiling a face

A **document** is the face's own writing: an essay, a letter, a paper, a book, a poem. Every word
in it is read as the face's. Writing about the face by someone else can also be a document, with
`--perspective third-person`. Text files, PDF and Word `.docx` are read; audio and video are
transcribed first.

An interview, transcript, dialogue or any other exchange between speakers is a **thread**. Compile
it with `--kind thread` and `--face-speaker` naming the face, so only the face's turns are used:

```bash
hw face:compile alice --file interview.txt --kind thread --face-speaker Alice
hw face:compile alice --file podcast.mp3 --kind thread --face-speaker A --rush
```

`face:compile` waits for the compile to finish. A compile may have a scheduled start: it says
when, and waits for it; `--rush` starts it as soon as possible, at the rush rate only if it starts before
that scheduled start, and `--no-wait` returns at once. A face runs at most 3 compiles at once, rushed or
not; more wait their turn.

A document's `--medium` is one of the 25 media `hw media:list` shows, each with what it
covers: a keynote is a `speech`, a diary a `journal entry`. A subcategory is not accepted.

A labelled dialogue compiled as a document is read as entirely the face's own words, other
speakers included. `face:compile` warns when a text file reads as a transcript.

## Maestro

`maestro:choices`, `maestro:decide` and `maestro:chat` are stateless: each call stands alone.
`--face` names the face: your own is `@alice`, another account's is `@owner~alice` (a system face
is `@head~socrates`), and a composite joins faces with `|`, `&`, `-` and `^`. Quote a composite,
because the shell reads `|` and `&`.

The face runs on `maestro-1`; `--fast` picks `maestro-1-fast`, which answers sooner and costs 10
times more on the Maestro part. `--decoder` names the model that answers after it: a decision
model for `maestro:decide` (default `jev-latest`), a chat model for `maestro:chat`. The full
model string is accepted in `--face` too:

| `--face` | Command |
|---|---|
| `@alice:maestro-1/choices` | `hw maestro:choices` (Maestro answers) |
| `@alice:maestro-1/gpt-5.4` | `hw maestro:chat` |
| `@alice:maestro-1/jev-latest` | `hw maestro:decide` |
| `@dana~alice:maestro-1/gpt-5.4` | another account's face, published or shared with you |
| `(@alice \| @bob):maestro-1-fast/gpt-5.4` | a composite |

The decoder's id is written as `hw models:list` lists it.

### Choices

`hw maestro:choices` asks a face what it would do (`POST /v1/choices`). Describe the situation
with `--state` (prose, at most 3,000 tokens) or `--state-file`, and ask with `--question`:

```bash
hw maestro:choices --face @alice --state "A startup offers me a lead role at a lower salary." --question "Should I take the offer?"
hw maestro:choices --face @head~socrates --state "A chain bakery opened across the street." --max-choices 3
hw maestro:choices --face "(@alice | @bob)" --fast --state-file situation.txt -q "What next?"
```

The face proposes the options it would weigh, strongest first. Leave `--question` out and it
proposes the question it would ask. In a state, `hw state:choices` writes the options into the
state instead. Prices: `hw models:list --kind upstream`.

### Decide

`hw maestro:decide` asks what a face would decide: a yes-or-no, a pick between options, or a
place on a graded scale, as numbers.

```bash
hw maestro:decide --face @alice --state "A colleague asks you to sign a proposal you have not read." \
  --question "Does the speaker sign?" --option yes="signs it as asked" --option no="declines to sign"
hw maestro:decide --face @alice --decoder clef --state-file situation.txt --questions-file questions.json
```

### Chat

`hw maestro:chat` sends your message to a face: the face steers, and the decoder writes the
reply. It picks `/v1/chat/completions`, `/v1/responses` or `/v1/messages` from the model catalog;
`--responses` and `--messages` force one. `--thread <name>` keeps a multi-turn conversation
under `~/.headwaters/threads`: the first call starts it with `--face` and `--decoder`, later calls
go on with it (`--threads` lists them, `--show` and `--delete` act on one).

```bash
hw maestro:chat --face @alice --decoder gpt-5.4 -m "What matters most to you in your work?"
hw maestro:chat --face "(@socrates | @nietzsche)" --decoder claude-sonnet-4-6 -m "What is virtue?"
hw maestro:chat --face @alice --decoder gpt-5.4 --thread offer -m "Should I take the offer?"
hw maestro:chat --thread offer -m "And if they raise the salary?"
```

The face's style is chosen for each request, from the face's built styles. `face:style:*` builds them.

## States

A state is a proof in progress, kept on the server: a tree of premises joined by AND and OR,
each box proved `[x]`, open `[ ]` or refuted `[-]`, and a last line that names what still stands
between you and a proved goal. Every node is a premise, named by its key. `hw state:create --use`
makes one for this directory (its id goes in `.headwaters/state`), and every `state:*` command
here or below works on it.

```bash
hw state:create --use
hw state:add "the dinner is planned" "A dinner party for six" --role goal --said "Plan a dinner party for six."
hw state:add "the guests" "Six, one vegan" --and "the dinner is planned"
hw state:refine "the dinner is planned" --face alice
hw state:get
hw state:get "the dinner is planned" --depth 2
```

`state:add` writes a box: `--role goal` or `--role test` (none is a fact), under a parent with
`--and` (all such children must hold) or `--or` (one candidate is enough), reading inputs with
`--on a,b`. `state:edit` changes one: a new value, a status, a test's run (`--status verified
--tested "<candidate>" --evidence "..."`), or what it waits on (`--await human`). `state:get`
shows the whole proof, or with a key one box, its branch and its messages; `state:delete`
removes one. Writing and reading a state are free.

`state:refine "<key>" --face <alias>` asks the face to refine a premise: it decides whether
the premise needs conditions (AND), a pinned meaning (OR, its candidates ranked), one test, or
the human's answer, and writes one tier of children (`-r` goes on down). `state:choices` asks the
face for candidates, and `state:decide` ranks them; a ranking never rules a candidate out, only a
failed test or the human does. These three are billed per call.

Several agents can work one state: `state:claim "<key>" <name>` gives a branch to one of them,
and writes into it by anyone else are refused until it is released (`--release`) or expires.
Every write takes `--as <name>`.

`state:add --jsonl <file>` adds many premises at once, and `state:edit --note` adds a note to one.
`state:items` lists a state's items in order, and `state:close` closes it. Like every `state:*`
command, they work on this directory's state unless `--state-id` names another.

### Keep the state in view

`hw state:hud` prints the state in three short lines, the same size whatever the size of the
proof: the root goal and how much of it is proved, the next candidate to try, what waits on the
human, the environment or a test, and the claims (`--as <name>` shows yours). The last line is
the command that shows the detail.

```
HUD · fs_QPSO… · "the dinner is planned" · open · 1/7 proved
next: 1.2.1 pasta primavera · waiting: human on 1.3 · held: 1.2 builder-A
drill: hw state:get "pasta primavera"
```

`hw state:hud --hook <event>` reads a hook event on stdin and prints that hook's output, so the
hook files for Claude Code and Codex are one line each:

| `--hook` | Hook | What it prints |
|---|---|---|
| `session-start` | SessionStart | the whole proof, and sets `HW_SESSION` for the session (Claude Code) |
| `user-prompt` | UserPromptSubmit | the HUD, as added context, on each user message |
| `post-tool` | PostToolUse | the HUD, after an `hw state:` write or every 15 tool calls |
| `statusline` | Claude Code `statusLine` | the HUD in one line, for the human |
| `stop` | Stop, SubagentStop | the proof's last line |
| `session-end` | SessionEnd | nothing; releases the session's claims |

`--harness codex` names the session for Codex. A hook never blocks and never fails: on any
error it prints nothing and exits 0. `hw state:hud on`, `off` or `auto` sets when the hooks show
the HUD, in `.headwaters/hud` next to the state file. `auto`, the default, shows it when the
directory has a state.

## Authentication

Login stores a JWT at `~/.headwaters/config.json`. You can also authenticate with environment
variables:

```bash
export HW_API_KEY=sk-faces-...
export HW_TOKEN=your_jwt
export HW_BASE_URL=https://api.faces.sh   # optional override
```

## Plans

- **Free**: a $5 activation, added as credits. Everything is paid as it goes, from credits.
- **Connect** ($17/month): 25M choices and steering tokens a month (6.25M a week, 1.6M per 5 hours) and
  500k compile source tokens.
- **Pro** ($49/month): 75M choices and steering tokens a month (18.75M a week, 4.8M per 5 hours) and
  1.5M compile source tokens.

Past an allowance, work is paid from credits only with `api_fallback` on (`hw account:preferences`).
Choices cost $0.42 per million input tokens and $1.00 per million output tokens on `maestro-1`.
On chat and decisions the steering costs $0.42 per million input tokens plus $0.00042 a call, with no
output charge, and the decoder its listed price plus 5%. `maestro-1-fast` is 10 times the
`maestro-1` price, on the Maestro part only. Compiling costs $16 per million source tokens, $21 for
a rush. Link a ChatGPT account with `hw account:connect openai` and interviews and style builds run on
the ChatGPT plan. Current prices: `hw models:list --kind all`.

## License

MIT. Copyright (c) 2026 Headwaters Lab Inc.
