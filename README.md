# Multi-Model Writers’ Room

A locally hosted room where one human and several independently configured
language models can discuss shared ideas and documents. Participants have
separate prompts, providers, context packages, activation decisions, fatigue,
and inspectable generation records. There is no chairman, vote, or required
final synthesis.

## What works

- Three to five OpenRouter, Ollama, or OpenAI-compatible participants
- Manual speaker invitation and bounded automatic parallel response waves
- Streaming text, provider-returned reasoning, usage, routing, and interruption
- Durable SQLite transcript, runtime state, generation events, and restart
  recovery
- Markdown, text, and PDF uploads in a content-addressed blob store
- FTS5 and local semantic retrieval with stable source citations
- Private server-side provider keys and safe, logged workspace/scratchpad tools
- In-process local ONNX embeddings and artifact summaries isolated in a worker
  thread
- A three-panel React room interface

The release intentionally omits arbitrary transcript editing, branching,
private notebooks, authentication, code mutation, repository/shell tools, and
cloud deployment.

## Requirements

- Node.js 22–24 (Node 24 LTS is the production target)
- Linux for the certified first release
- An OpenRouter key, a running Ollama server, or another OpenAI-compatible
  endpoint
- Network access on first document ingestion so the pinned local ONNX models
  can be cached under `data/models`

## Run locally

```bash
npm install
cp .env.example .env
# Add OPENROUTER_API_KEY to .env.
npm run dev
```

The browser UI runs at `http://127.0.0.1:5173` in development. The Express API
runs at `http://127.0.0.1:8787`.

For the production-shaped single-server build:

```bash
npm run build
npm start
```

Then open `http://127.0.0.1:8787`.

Ollama is discovered at `http://127.0.0.1:11434/v1` by default. Override it
with `OLLAMA_BASE_URL`. A generic endpoint uses
`OPENAI_COMPATIBLE_BASE_URL` and `OPENAI_COMPATIBLE_API_KEY`.

Provider credentials are never persisted or returned to the browser.

## Data layout

```text
data/
  room.db
  blobs/<sha-prefix>/<sha256>
  models/
```

Change the root with `WRITERS_ROOM_DATA_DIR`. SQLite runs in WAL mode and is the
sole authority for rooms, messages, generations, runtime state, artifacts,
chunks, citations, tool calls, and scratchpad notes.

## Verification

```bash
npm test
npm run typecheck
npm run build
npm audit --audit-level=high
```

The behavioral tests cover durable replay, normalized provider streams,
generation inspection, parallel scheduling, mention/fatigue behavior, and
hybrid workspace retrieval.

## Architecture

- `packages/contracts` owns shared schemas and WebSocket event contracts.
- `apps/server` owns persistence, providers, scheduling, tools, ingestion,
  local ML, HTTP, and WebSocket delivery.
- `apps/web` is a React/Vite client; it contains no provider credentials or
  authoritative room state.

The fatigue and room-pressure algorithms are clean-room adaptations of concepts
proven in `psfn-framework`; this project imports none of that companion
runtime’s source or substrate.
