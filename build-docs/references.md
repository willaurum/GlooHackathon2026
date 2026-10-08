# Reference reading

The published guidance Tekton's design follows. It covers agent design patterns, tool use,
orchestration, evaluation, human-in-the-loop escalation and agent security, plus the framework and
platform documentation behind the stack. Each entry says what the source recommends and where Tekton
does it, so a reviewer can check the claim against the code.

Sources were checked in October 2026.

## How Tekton maps to the literature

| Pattern (source) | Where Tekton does it |
|---|---|
| Workflows before autonomous agents; add complexity only when it pays (Anthropic, OpenAI, Microsoft) | The agentic website builder is a fixed pipeline (Import → Extract → Clarify → Confirm → Build) run by plain code: `backend/app/builder.py` module docstring |
| Orchestrator-workers / concurrent pattern (Anthropic, Microsoft, Google) | `builder.extract_all` sends every page to an info reader and pages of a known type to specialist readers (`builder_agents.py`), run in parallel under one deadline |
| Routing (Anthropic, Google) | `builder_agents.specialists_for` picks the specialists for a page by its type; `builder_crawl.score` ranks pages most useful first by rules, not by the model |
| Evaluator / maker-checker (Anthropic evaluator-optimizer, Microsoft maker-checker) | Every AI claim must quote its source exactly or it is dropped (`builder.grounded`, `builder.ai_claims`); specialist output is checked by `builder_agents.check` |
| Tool use with typed schemas (Anthropic tool writing, OpenAI, ReAct) | Specialist readers answer through typed tools validated by Pydantic models (`builder_agents.Item` and subclasses); the chat assistant runs a bounded tool loop (`backend/app/chat.py`, `MAX_TOOL_CALLS = 8`) |
| Human-in-the-loop on uncertainty and on high-impact actions (OpenAI, Google PAIR, NIST) | Builder conflicts are never resolved without the church's answer (Clarify/Confirm steps). The chat files a request only after the person says yes (`request_connection`), and staff review every request before anyone reaches out. `hand_off_to_staff` covers pastoral care and crisis (988/911). |
| Least privilege, no excessive agency (OWASP LLM06, Meta Rule of Two) | The chat's tools can only file requests for staff review; they cannot send messages, spend money or change site content. The backend container has `enableInternet = false` with an explicit `allowedHosts` list (`api/index.ts`); church sites are fetched through the `builder-fetch` bridge (`api/builderfetch.ts`) |
| Prompt-injection resistance (OWASP LLM01, lethal trifecta) | Imported page text is untrusted input. The AI can only propose values that are quoted from that text, and nothing it reads can trigger an outbound action |
| Evals: code-based graders, capability and regression suites (Anthropic evals guide) | Fixture church sites with `expected.json` answers (`backend/tests/fixtures/builder/`) scored by `builder_score.py` in `test_builder_site.py`, `test_builder_deep.py` and the other builder tests |
| Transparency and source attribution (Google PAIR, NIST AI 600-1) | Every builder value keeps its quote and a source link that jumps to the exact text (URL text fragments); the import shows its steps as it runs |
| Respect for site owners (RFC 9309) | robots.txt and Crawl-delay are obeyed for every host the import touches (`builder.py`, `builder_crawl.HostPolicy`) |

## Agent design patterns and orchestration

- **Anthropic, [Building effective agents](https://www.anthropic.com/research/building-effective-agents)** (Dec 2024).
  - Distinguishes *workflows*, where code drives the path, from *agents*, where the model drives it.
  - Names five workflow patterns: prompt chaining, routing, parallelization, orchestrator-workers and evaluator-optimizer.
  - Advises the simplest design that works. This is the main justification for the builder being plain-code orchestration with AI workers.
- **Microsoft Azure Architecture Center, [AI agent orchestration patterns](https://learn.microsoft.com/azure/architecture/ai-ml/guide/ai-agent-design-patterns).**
  - Covers sequential, concurrent, group chat (including maker-checker), handoff and magentic orchestration.
  - Recommends a single agent or plain code when the task is well defined.
- **Google Cloud, [Choose a design pattern for your agentic AI system](https://docs.cloud.google.com/architecture/choose-design-pattern-agentic-ai-system).** A decision guide covering:
  - single-agent, sequential, parallel, loop and coordinator patterns;
  - human-in-the-loop as an explicit pattern.
- **Google, *Agents* whitepaper** (Wiesinger, Marlow and Vuskovic, Sept 2024). Describes an agent as model + tools + orchestration layer, with tools as extensions, functions or data stores.
- **OpenAI, [A practical guide to building agents](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf).** Covers:
  - when to build an agent and single- vs multi-agent designs;
  - layered guardrails;
  - planning for human intervention when failure thresholds are exceeded or an action is high-risk or irreversible.
- **Yao et al., [ReAct: Synergizing Reasoning and Acting in Language Models](https://arxiv.org/abs/2210.03629)** (Princeton and Google Research, ICLR 2023). The reason-act-observe tool loop behind the chat assistant.
- **Shinn et al., [Reflexion: Language Agents with Verbal Reinforcement Learning](https://arxiv.org/abs/2303.11366)** (NeurIPS 2023).
  - Self-correction from feedback.
  - Contrast: Tekton deliberately uses *external*, code-based checks (an exact quote match) instead of having the model judge itself.

## Tool use and context

- **Anthropic, [Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents).** Advises:
  - few, well-named tools with clear descriptions;
  - meaningful return values;
  - evaluating tools with realistic tasks.
- **Anthropic, [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents).** Keep context small and relevant. Tekton gives each reader one page plus a focused field list.
- **Gloo AI, [Tool use](https://docs.gloo.com/api-guides/tool-use) and [endpoint types](https://docs.gloo.com/api-guides/endpoint-types).**
  - Gloo uses OpenAI-compatible function schemas.
  - The guarded endpoints add input guardrails, output moderation and values alignment.

## Evaluation

- **Anthropic, [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)** (Jan 2026). Covers:
  - code-based, model-based and human graders;
  - capability evals vs regression evals;
  - pass@k vs pass^k for nondeterministic agents.
  - Tekton's builder fixtures are code-graded capability and regression evals.
- **NIST, [AI 600-1: Generative AI Profile](https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf)** (July 2024).
  - Risks covered include confabulation, information integrity and human-AI configuration.
  - Pre-deployment testing and provenance are among its suggested actions.

## Human-in-the-loop and trust

- **Google PAIR, [People + AI Guidebook](https://pair.withgoogle.com/guidebook/)**, chapters *Explainability + Trust* and *Feedback + Control*. Advises:
  - showing people why the AI produced a result;
  - letting them correct it;
  - matching the level of automation to the stakes.
- **OpenAI practical guide** (above). Hand control to a human on high-risk actions or repeated failure.

## Agent security

- **Meta, [Agents Rule of Two](https://ai.meta.com/blog/practical-ai-agent-security/)** (Oct 2025).
  - An agent should have no more than two of: (A) processing untrusted input, (B) access to sensitive systems or private data, (C) changing state or communicating externally.
  - With all three, it needs human approval.
  - The builder reads untrusted pages (A), but its output is a draft a person reviews, and it has no outbound actions (no C).
- **Simon Willison, [The lethal trifecta for AI agents](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/)** (June 2025). The same risk framed as private data + untrusted content + external communication.
- **OWASP, [Top 10 for LLM Applications 2025](https://genai.owasp.org/llm-top-10/).**
  - LLM01 Prompt Injection.
  - LLM06 Excessive Agency: least privilege, validated tool inputs, human confirmation of impactful actions.

## Framework and platform documentation

- **React:**
  - [Thinking in React](https://react.dev/learn/thinking-in-react);
  - [Passing data deeply with context](https://react.dev/learn/passing-data-deeply-with-context), the pattern behind `ChurchContext`.
- **Vite:** [Guide](https://vite.dev/guide/).
- **FastAPI and Pydantic:**
  - [FastAPI](https://fastapi.tiangolo.com/);
  - [Pydantic validators](https://docs.pydantic.dev/latest/concepts/validators/). Request models validate every write; field validators handle email, phone and length limits.
- **Cloudflare Durable Objects:**
  - [SQLite storage backend](https://developers.cloudflare.com/changelog/2025-04-07-sqlite-in-durable-objects-ga);
  - [SaaS data isolation](https://developers.cloudflare.com/use-cases/saas/data-isolation/). Tekton gives each church its own SQLite-backed Durable Object (`ChurchDB`), so one church's data is never in another's database.
- **Cloudflare Containers, [outbound traffic](https://developers.cloudflare.com/containers/platform-details/outbound-traffic/).**
  - `enableInternet`, `allowedHosts` and `outboundByHost`: outbound handlers run in the Worker outside the container and can hold secrets the container never sees.
  - Tekton's container runs with no general internet access.
- **IETF, [RFC 9309: Robots Exclusion Protocol](https://www.rfc-editor.org/rfc/rfc9309).**
- **WICG, [URL Fragment Text Directives](https://wicg.github.io/scroll-to-text-fragment/)** (`#:~:text=`), used for the builder's links to its sources.
