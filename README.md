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
  <img alt="License not yet granted" src="https://img.shields.io/badge/license-not%20yet%20granted-lightgrey">
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

## Quick start

Requirements:

- Node.js 22–26; Node 24 LTS is the primary target
- Linux for the currently tested local release
- One of: an OpenRouter key, a running Ollama server, or an OpenAI-compatible endpoint

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

An explicit `@Voice Name` directs the message only to that participant. Manual
Invite bypasses ordinary activation selection but still uses the normal
generation and persistence path.

## Providers and configuration

Provider credentials remain server-side. The browser receives model catalogs
and capabilities, never API keys.

| Variable | Purpose | Default |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | Enables OpenRouter and its live model catalog | unset |
| `OLLAMA_BASE_URL` | Ollama’s OpenAI-compatible API | `http://127.0.0.1:11434/v1` |
| `OPENAI_COMPATIBLE_BASE_URL` | Generic OpenAI-compatible endpoint | unset |
| `OPENAI_COMPATIBLE_API_KEY` | Optional key for the generic endpoint | unset |
| `WRITERS_ROOM_DATA_DIR` | SQLite, blobs, model cache, and generated local state | `./data` |
| `WRITERS_ROOM_HOST` | API bind address | `127.0.0.1` |
| `WRITERS_ROOM_PORT` | API port | `8787` |

The Settings page lets you choose the fallback model, inspect provider model
catalogs, tune room pacing, and build reusable voice templates. Voice templates
can also be generated as editable drafts from a name and source text.

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
with local embeddings and preserves chunk provenance for citations.

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
- No room branches, private agent notebooks, image understanding, or audio ingestion yet
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

**Are documents copied into every prompt?** No. Agents receive a manifest and
retrieve relevant chunks through read-only workspace tools.

**Can this edit my repository?** No. The initial tool surface is intentionally
read-oriented and cannot silently mutate code or uploaded documents.

## About contributions

*About Contributions:* Please don't take this the wrong way, but I do not accept outside contributions for any of my projects. I simply don't have the mental bandwidth to review anything, and it's my name on the thing, so I'm responsible for any problems it causes; thus, the risk-reward is highly asymmetric from my perspective. I'd also have to worry about other "stakeholders," which seems unwise for tools I mostly make for myself for free. Feel free to submit issues, and even PRs if you want to illustrate a proposed fix, but know I won't merge them directly. Instead, I'll have Claude or Codex review submissions via `gh` and independently decide whether and how to address them. Bug reports in particular are welcome. Sorry if this offends, but I want to avoid wasted time and hurt feelings. I understand this isn't in sync with the prevailing open-source ethos that seeks community contributions, but it's the only way I can move at this velocity and keep my sanity.

## License

No software license has been granted yet. The repository is publicly readable,
but public visibility alone does not grant permission to copy, modify, or
redistribute the code. Add an explicit license before treating this as an
open-source project.
