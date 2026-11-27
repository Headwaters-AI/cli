# Changelog

## 0.0.1

The first release of `hwai`, the Headwaters command line, published as `@headwaters-ai/cli`.

```bash
npm install -g @headwaters-ai/cli
```

It talks to https://api.headwaters.ai by default. Commands are grouped by topic, as `hwai topic:command`:

- **face:** create a face, compile an author's documents and threads into it, and list, edit, share, publish, compare and delete faces. Also its styles, pictures, tags, fidelity runs and benchmarks.
- **maestro:** ask a face what it would do. `maestro:choices` gives the options it would weigh, strongest first, or the question it would ask; `maestro:decide` gives a typed decision; `maestro:chat` chats with a face on any chat model. `--fast` picks the faster maestro model.
- **state:** a proof in progress that your agent builds with a face, kept on the server: add, edit, refine, claim and close its premises, and get its proof. `state:create --use` makes one for the current directory.
- **state:hud:** the state in three lines, with a toggle (on, off, auto) and hooks for your agent's harness.
- **account:** register, sign in, plan, credits, cards, connections and preferences.
- **key:** create, list, edit and revoke API keys.

Every command takes `--json`, and `--toon` for a more compact form of the same data. Run `hwai <command> --help` for details.
