<p align="center">
  <img src="apps/web/public/favicon.svg" width="96" alt="Multi-Model Writers' Room logo">
</p>

<h1 align="center">Multi-Model Writers’ Room</h1>

<p align="center">
  A persistent local room where one human and several independently configured language models can think together.
</p>

<p align="center">
  <img alt="Node 22+" src="https://img.shields.io/badge/Node-22%2B-339933?logo=nodedotjs&logoColor=white">
  <img alt="Local first" src="https://img.shields.io/badge/storage-local--first-5b5bd6">
  <img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue">
</p>

```bash
git clone https://github.com/axAilotl/multi-model-writers-room.git
cd multi-model-writers-room && npm install
cp .env.example .env && npm run dev
```

## Why this exists

Using several models usually means maintaining several browser tabs, copying
context between them, and manually deciding who should answer next. Writers’
Room gives the models one durable public transcript and one shared evidence
table while keeping their prompts, personas, providers, contexts, and working
state independent.

This is a room, not a council. There is no voting, chairman, forced consensus,
or mandatory synthesis. Participants can answer the human, respond to each
other, remain silent, or take several bounded autonomous turns.

| Capability | What it provides |
| --- | --- |
| Independent voices | Separate provider, model, system prompt, persona, parameters, and context budget per participant |
| Automatic conversation | Each voice decides whether it has something useful to add; a fatigue-aware arbiter balances willing speakers |
| Shared table | Drag-and-drop Markdown, text, and PDF artifacts with summaries, structural chunks, hybrid search, and stable citations |
| Inspectable generations | Streaming output, provider reasoning when available, retrieved sources, tool calls, tokens, latency, and cost |
| Durable rooms | SQLite-backed rooms, transcripts, agents, settings, runtime state, artifacts, scratchpad notes, and generation events |
| Human control | Pause, invite a speaker, mute or remove a participant, switch/delete rooms, reset chat while retaining the room, and cap autonomous waves |

Four room formats provide meaningful behavior bundles rather than cosmetic
presets:

| Format | Pace and routing |
| --- | --- |
| Workshop | Normal conversational pace with balanced speaker routing |
| Writers’ Room | Fast, interruptible crosstalk and rapid idea mutation |
| Shark Tank | Present, steelman, challenge, defend, and rebut |
| Fishbowl | One voice at a time with private, evidence-grounded study drafts before the public answer |

## Quick start

Requirements:

- Node.js 22–26; Node 24 LTS is the primary target
- Linux for the currently tested local release
- One of: an OpenRouter key, a running Ollama server, an OpenAI-compatible endpoint, or an explicitly enabled PSFN companion endpoint

Start the development servers:

```bash
npm install
cp .env.example .env
# Put provider credentials in .env. Never commit that file.
npm run dev
```

Open <http://127.0.0.1:5173>. Create a room, configure a fallback model in
Settings, create or generate voice templates, add three to five voices, and
drop reference material onto the table. Auto-conversation is enabled per room
and can be paused from the room header.

For the production-shaped single-server build:

```bash
npm run build
npm start
```

Then open <http://127.0.0.1:8787>.

## How automatic replies work

After a human message, every eligible participant performs a small structured
activation decision. A participant that chooses to speak becomes a candidate;
its ranking score is telemetry and never silently vetoes that decision. The
speaker arbiter then applies direct-address priority and a deterministic
“speak-least” rotation adapted, with its owner’s authorization, from the PSFN
Framework. Fatigue, room pressure, responder limits, wave limits, and reply
limits prevent dogpiles and infinite model-to-model loops.

If every eligible voice defers on a new human message, Auto mode explicitly
selects one balanced fallback speaker so the room does not appear dead. The UI
labels that admission as a scheduler fallback and preserves the participant's
original activation decision separately.

An explicit `@Voice Name` directs the message only to that participant. Manual
Invite bypasses ordinary activation selection but still uses the normal
generation and persistence path.

## Providers and configuration

Provider connections can be added and replaced under **Settings → Providers &
models**. OpenRouter accepts a key, Ollama accepts a base URL and optional key,
and the generic OpenAI-compatible connection accepts a base URL and optional
key. Changes take effect immediately without restarting the room server.

Credentials remain server-side. Keys saved through Settings are persisted in
the local, git-ignored SQLite database; API responses expose only whether a
credential exists. Environment variables remain available for unattended
startup and are restored when a saved override is removed.

| Variable | Purpose | Default |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | Enables OpenRouter and its live model catalog | unset |
| `OLLAMA_BASE_URL` | Ollama’s OpenAI-compatible API | `http://127.0.0.1:11434/v1` |
| `OLLAMA_API_KEY` | Optional key for an authenticated Ollama proxy | unset |
| `OPENAI_COMPATIBLE_BASE_URL` | Generic OpenAI-compatible endpoint | unset |
| `OPENAI_COMPATIBLE_API_KEY` | Optional key for the generic endpoint | unset |
| `PSFN_PROVIDER_ENABLED` | Exposes the optimized stateful PSFN provider | `false` |
| `PSFN_BASE_URL` | PSFN origin or `/v1` endpoint | unset |
| `PSFN_API_KEY` | Optional PSFN bearer credential | unset |
| `PSFN_SESSION_MODE` | `header` for per-room continuity or `fixed` for one shared remote session | `header` |
| `PSFN_EXPECTED_COMPANION_ID` | Optional pinned remote identity; first successful test pins it automatically | unset |
| `PSFN_CONTEXT_LENGTH` | Bounded adapter input context | `32768` |
| `PSFN_ALLOW_INSECURE_HTTP` | Allow HTTP only for private/loopback endpoints | `false` |
| `WRITERS_ROOM_DATA_DIR` | SQLite, blobs, model cache, and generated local state | `./data` |
| `WRITERS_ROOM_HOST` | API bind address | `127.0.0.1` |
| `WRITERS_ROOM_PORT` | API port | `8787` |

The Settings page lets you choose the fallback model, inspect provider model
catalogs, tune room pacing, and build reusable voice templates. Voice templates
can also be generated as editable drafts from a name and source text.

Each saved voice also owns a private reference library in Voice Settings.
Markdown, text, and PDF references can be uploaded, inspected, and removed
there. Uploading through a linked participant's Library control adds to the same
template library; existing room instances receive it and future instances
inherit it automatically. Materialized evidence remains private to that voice.

### Stateful PSFN provider

PSFN is a separate provider kind, not a generic OpenAI-compatible alias. Enable
it explicitly with `PSFN_PROVIDER_ENABLED=true`, then configure and test it in
**Settings → Providers & models**. The test performs the PSFN identity and model
handshake and pins the companion identity so an unexpected remote change fails
closed. A successful save or connection test also creates one deduplicated
`PSFN — <remote name>` voice template, ready to add to rooms.

PSFN owns its persona, system prompt, faculties, memory, and internal reasoning.
Writers’ Room uses ordinary fallback models for activation and housekeeping,
then sends PSFN only a bounded event envelope containing new completed public
messages and relevant shared-table excerpts. It never sends local persona
prompts, failed drafts, tool events, repository contents, or another voice’s
private library through this path. Intentional no-reply is recorded without an
empty chat bubble.

Header session mode creates stable per-room continuity using `X-Session-ID`.
Fixed mode enters one shared durable PSFN conversation across rooms and requires
explicit confirmation when reused. A local chat reset retains participants and
artifacts but does not delete PSFN’s remote history or memory. If a connection
drops after a turn may have been admitted, the delivery is marked ambiguous and
must be resolved in the participant panel; the app does not silently risk a
duplicate. See [the adapter specification](docs/psfn-adapter-spec.md) for the
protocol and failure semantics.

### Model-aware context and rolling history

New voices auto-scale their working context from the selected model's reported
capabilities. Models at or below the 128k class use up to 128k; models in the
256k class use up to 256k; very-large-context models use a 256k working window
with a 512k hard ceiling. The automatic working budget is divided in a
normalized 1:2:3 ratio: one-sixth for system/persona instructions, one-third
for table and persona-library evidence, and one-half for the live transcript.
The Voice Template editor exposes an Auto-scale switch and manual limits for
rooms that need a different policy.

At 70% of a participant's transcript allotment, Writers’ Room creates a durable
conversation episode and substitutes that summary for covered raw turns in
that participant's next prompt. Compaction is participant-aware: a 128k voice
cannot force a 256k voice to shed raw context early. The original messages are
never replaced or deleted; they remain in SQLite and can be recovered by models
with `search_conversation_history` and `read_message_range`. Chat Reset is the
explicit operation that clears transcript and episode history while preserving
participants and table artifacts.

## Architecture

```text
┌──────────────── React / Vite ────────────────┐
│ workspace table │ conversation │ participants │
└──────────────────────┬────────────────────────┘
                       │ HTTP + WebSocket
┌──────────────────────▼────────────────────────┐
│ Express runtime                               │
│ rooms │ activation + arbiter │ generation     │
│ tools │ ingestion + retrieval │ provider gate │
└──────────────┬───────────────────┬─────────────┘
               │                   │
      ┌────────▼────────┐   ┌──────▼──────────────────┐
      │ SQLite + FTS5   │   │ OpenRouter / Ollama /   │
      │ local blob store│   │ OpenAI-compatible APIs  │
      └─────────────────┘   └─────────────────────────┘
```

- `packages/contracts` owns shared schemas and WebSocket event contracts.
- `apps/server` owns persistence, providers, scheduling, tools, ingestion,
  local ML, HTTP, and WebSocket delivery.
- `apps/web` owns the React room and settings interface. It has no provider
  credentials or authoritative room state.

The prompt contains a compact workspace manifest, not every document. Agents
retrieve specific evidence through read-only tools. Markdown and text files are
processed locally; PDF text is structurally extracted. Retrieval combines FTS5
with local embeddings and preserves chunk provenance for citations. Repository
directories are indexed as a bounded read-only corpus: participants ask the
Table Researcher for cited answers rather than receiving or searching raw
repository contents directly. This bounded utility is always available to
tool-capable room participants; when synthesis is enabled it uses the fallback model selected by
the human, but it never receives private persona-library material. A saved
voice's interviews, excerpts, and other grounding material belong to its
template and are materialized into private, indexed room artifacts that are not
exposed to other voices.

## Data and privacy

All durable application state is local by default:

```text
data/
  room.db
  blobs/<sha-prefix>/<sha256>
  models/
```

`data/`, SQLite files and sidecars, blobs, exports, `.env*` files except
`.env.example`, browser evidence, build output, and logs are ignored by Git.
Uploaded documents and room messages are sent only to the participant providers
you configure when they are included in a model request. This application has
no authentication and should remain bound to localhost unless you add an access
control layer.

## Development commands

```bash
npm run dev          # API + Vite development servers
npm run typecheck    # all TypeScript projects
npm test             # unit/integration tests plus dev-runtime smoke check
npm run build        # contracts, server, and web production builds
npm run test:browser # isolated Playwright end-to-end workflow
npm audit --audit-level=high
```

The browser test uses a temporary data directory and a fixture model provider;
it does not need a real provider key or touch your existing rooms.

## Comparison

| Approach | Shared transcript | Independent personas | Automatic turn-taking | Shared document retrieval | Local persistence |
| --- | ---: | ---: | ---: | ---: | ---: |
| Separate provider tabs | No | Yes | No | No | Provider-dependent |
| Answer-comparison tools | Usually | Limited | No | Sometimes | Varies |
| Council/voting pipelines | Yes | Yes | Orchestrated rounds | Sometimes | Varies |
| Multi-Model Writers’ Room | Yes | Yes | Loose, fatigue-aware waves | Yes | Yes |

## Troubleshooting

**The page loads but no model answers.** Check that the room is running, Auto is
on, at least one participant is unmuted, and its provider/model is configured.
Use Invite to distinguish provider failure from activation silence. Generation
errors and activation decisions are visible on the message/participant panels.

**OpenRouter returns 401 or 403.** Confirm `OPENROUTER_API_KEY` is present in the
untracked `.env`, restart `npm run dev`, and rotate any key that has ever been
pasted into chat, logs, or source control.

**The UI reports 502 Bad Gateway.** The Vite server proxies `/api` to port 8787.
Check the server process output and <http://127.0.0.1:8787/api/v1/health>. Failed
message drafts remain in the composer so they can be resent.

**An upload is stuck or failed.** Markdown and text should process quickly. PDF
extraction and first-run embedding model downloads take longer. Failed artifacts
offer Retry and Delete controls on the table.

**Ollama models do not appear.** Confirm Ollama is running and its compatible
endpoint is reachable at `OLLAMA_BASE_URL`. Restart the app after changing the
endpoint.

## Current limitations

- Single local human; no multi-user authentication or authorization
- No cloud deployment hardening
- No arbitrary source-code mutation, repository shell, or general agent execution
- No room branches, general-purpose private notebooks, image understanding, or audio ingestion yet
- Provider reasoning is shown only when the provider actually returns it
- Local embeddings may download model assets on first ingestion
- Linux is the tested platform for this alpha release

## FAQ

**Does every model receive the same prompt?** No. Every request is assembled
independently from the voice’s prompt, recent transcript, retrieved history,
workspace evidence, notebook budget, and capabilities.

**Will all models answer every message?** No. Each model may respond or remain
silent. The arbiter selects up to the room’s responder limit from those that opt
in.

**Can models see each other’s hidden reasoning?** No. They see public messages.
Provider-returned reasoning is stored separately for human inspection and is
not treated as another model’s public context.

**Does compaction delete old chat?** No. It only changes the bounded prompt sent
to an individual model. Episode summaries carry their source message range, and
the complete raw transcript remains searchable in SQLite.

**Are documents copied into every prompt?** No. Agents receive a manifest and
retrieve relevant chunks through read-only workspace tools.

**Can this edit my repository?** No. The initial tool surface is intentionally
read-oriented and cannot silently mutate code or uploaded documents.

## About contributions

*About Contributions:* Please don't take this the wrong way, but I do not accept outside contributions for any of my projects. I simply don't have the mental bandwidth to review anything, and it's my name on the thing, so I'm responsible for any problems it causes; thus, the risk-reward is highly asymmetric from my perspective. I'd also have to worry about other "stakeholders," which seems unwise for tools I mostly make for myself for free. Feel free to submit issues, and even PRs if you want to illustrate a proposed fix, but know I won't merge them directly. Instead, I'll have Claude or Codex review submissions via `gh` and independently decide whether and how to address them. Bug reports in particular are welcome. Sorry if this offends, but I want to avoid wasted time and hurt feelings. I understand this isn't in sync with the prevailing open-source ethos that seeks community contributions, but it's the only way I can move at this velocity and keep my sanity.

## License

Licensed under the [MIT License](LICENSE).
