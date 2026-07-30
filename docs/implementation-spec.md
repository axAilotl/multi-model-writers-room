# Room + Table implementation specification

The first release is a Linux-first local web application for one human and
three to five independently configured language-model participants.

It must provide:

1. Durable SQLite rooms, agents, messages, generations, runtime state, event
   history, artifacts, chunks, citations, scratchpad notes, and tool calls.
2. Server-only OpenRouter, Ollama, and generic OpenAI-compatible adapters with
   normalized streaming text, reasoning, tools, usage, errors, and aborts.
3. Manual and automatic speaker selection. Automatic selection uses
   deterministic eligibility, a small structured decision by each candidate's
   own model, parallel response waves, fatigue, room pressure, and hard
   autonomous-run caps.
4. Markdown, plain-text, and PDF ingestion with SHA-256 blob deduplication,
   structural chunks, FTS5, optional vector search, reciprocal-rank fusion,
   summaries, and stable citations.
5. A shared scratchpad and read-oriented model tool surface.
6. A three-panel React interface exposing the workspace, public conversation,
   participant state, room controls, reasoning, sources, tools, activation
   rationale, usage, latency, and cost.

Provider keys are read only from environment variables. The first release does
not include arbitrary transcript editing, branching, private notebooks, source
mutation, authentication, image understanding, or repository/shell tools.

Acceptance requires a four-agent room to survive restart, discuss two uploaded
documents through bounded autonomous waves, expose its retrieved evidence and
provider-returned reasoning, pause safely, support manual redirection, and
avoid infinite response loops.

