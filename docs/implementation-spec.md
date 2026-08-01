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
7. Four room formats: Workshop for balanced conversation, Writers’ Room for
   interruptible high-crosstalk ideation, Shark Tank for present-and-defend
   debate, and Fishbowl for slow evidence-grounded deliberation.
8. Persona-private source libraries and up to three inspectable
   application-level Fishbowl study passes. These drafts are not labeled or
   represented as provider chain-of-thought. Reference libraries are managed on
   saved voice templates, synchronize to linked room participants, and are
   inherited when the voice is added to another room.
9. Read-only repository-directory ingestion behind a bounded Table Researcher
   utility. Participant tools cannot directly search or read repository chunks;
   the broker preserves source citations and cannot access persona libraries.
10. Model-aware rolling context. New voices derive 128k/256k working windows
    from provider metadata, use a 256k working target and 512k hard ceiling for
    very-large-context models, and divide the working window 1:2:3 among
    system/persona, retrieved table or personal evidence, and live transcript.
    A participant compacts at 70% of its own transcript allocation. Durable
    episode summaries replace covered raw turns only in that participant's
    prompt; canonical messages stay in SQLite and remain available through
    `search_conversation_history` and `read_message_range`.

Provider keys are read only from environment variables. The first release does
not include arbitrary transcript editing, branching, general-purpose private
notebooks, source mutation, authentication, image understanding, repository
shell access, or repository mutation. Workspace-search and chunk HTTP routes
are a human UI inspection boundary; they are not exposed to model participants,
whose only repository path is the Table Researcher.

Acceptance requires a four-agent room to survive restart, discuss two uploaded
documents through bounded autonomous waves, expose its retrieved evidence and
provider-returned reasoning, pause safely, support manual redirection, and
avoid infinite response loops.

Room pressure and fatigue recover over time. Auto mode guarantees one clearly
labeled scheduler-fallback response when every eligible participant defers on
a human message, while preserving the participants’ original decisions.
Human interjections are queued FIFO and supersede further autonomous
continuation after the current in-flight response wave.
