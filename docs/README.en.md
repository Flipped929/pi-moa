# Pi-MoA 🐙

**Multi-model orchestration for the [pi coding agent](https://github.com/earendil-works/pi-mono): one captain model dispatches, cheap sub-models execute, an independent governance plane watches.**

Turn pi into a "player-coach" multi-model system: a strong model (Kimi K3 / Claude / GPT…) schedules, judges and takes the hardest slices; cheap models (DeepSeek / Haiku…) run analysis and execution in parallel; everything communicates via a three-card protocol and stays fully auditable.

[中文 README](../README.md) · [Architecture](architecture.md) · [Configuration](configuration.md) · [Playbooks](playbooks.md)

## Why

- 40–60% of tokens in coding sessions are search / mechanical edits / formatting — your flagship model shouldn't burn on those
- Single-model long sessions hit the context wall (observed: compaction itself fails at 900k+ tokens)
- Mixture-of-Agents only works with **real heterogeneity**: same-model roles need adversarial prompts, isolated contexts, and a cross-family reviewer
- Routing alone isn't enough: you also need hard security boundaries, quality gates, and cost baselines

## Architecture in 30 seconds

![Pi-MoA dual-plane architecture](assets/architecture.svg)

```
you
 ▼
captain (strong model, pi main session) ── split / dispatch / spot-check / judge
 ├─ executor  (cheap model, scoped write)  ← real execution slices
 ├─ analyst   (cheap model, read-only)     ← analysis
 ├─ critic    (cheap model, adversarial)   ← diff review / fault-finding
 └─ devil     (different-family model)     ← heterogeneous devil's advocate
      │ result cards / handoff packets (star topology, all via captain)
      ▼
 blackboard .pi/moa/<task>/  ← full audit trail; Navigator governance plane audits async
```

Hard security boundaries (scope-guard — physical interception, not prompt promises):
protected paths write-ban · sub-agents confined to cwd (incl. bash-redirect bypass interception) · outbound payload PII auto-redaction · session token budget alerts

## Quick start (5 minutes)

Prerequisite: [pi](https://github.com/earendil-works/pi-mono) installed, with at least one model provider configured.

```bash
git clone https://github.com/Flipped929/pi-moa.git && cd pi-moa
./install.sh                      # idempotent, auto-backup
pi
/moa-on                           # enable orchestration
/moa-status                       # 4 roles should show ✅
```

Then drop `examples/demo-review/c.py` into a test directory and ask pi:

> Review c.py in this directory: dispatch analyst and critic in parallel, then give me the verdict.

Expected: captain creates a blackboard, fans out, critic finds the 2 guaranteed-crash bugs, final report lands in `.pi/moa/`.

## Commands

`/moa on|off|status|review <topic>` — or shortcuts `/moa-on` `/moa-off` `/moa-status` `/moa-review <topic>`

## Model roster

Defaults: `executor/analyst/critic = deepseek-v4-flash`, `devil/captain = kimi-k3`.
Edit `model:` in `~/.pi/agent/agents/*.md` to swap in what you have — the architecture is vendor-agnostic, requiring only:
- captain = your strongest model (long context preferred)
- devil = a **different model family** than the execution layer (heterogeneity is the point)
- image-bearing tasks always go to a multimodal model (sub-models are text-only)

## Core concepts

| Concept | In one line |
|---|---|
| Three-card protocol | task card (write scope) / result card (≤300 words + artifact paths) / handoff packet (with dead-ends list) |
| Dispatch matrix | task type → sub-model count: high-overlap reading 0–1 · coding 2–3 parallel · review full panel 3 |
| Spot-check | captain re-verifies 10–30% of sub-model evidence; one miss → full re-check + trust demotion |
| Evidence discipline | commit messages, comments, "verified" claims are NOT evidence — check the code itself |
| Overlap tax | token waste from sub-models re-reading the same material — avoided via "one-read, multi-review" |
| Navigator | async governance plane: role trust scores / overlap tax / multi-vs-single model cost baselines |

## Repository layout

```
extensions/   pi extensions (moa-mode dispatch / scope-guard security / subagent spawning)
agents/       role definitions (executor/analyst/critic/devil)
moa/          card templates + guard-policy example
examples/     demo-review 5-minute demo
docs/         architecture / configuration / playbooks
test/         vitest suite (core.ts: 100% coverage)
scripts/      e2e smoke (mock provider, zero API cost)
install.sh / uninstall.sh
```

## Development

```bash
npm install
npm test            # 39 unit tests
npm run test:coverage
npm run e2e         # e2e smoke with mock OpenAI endpoint
```

## Status

v0.2.0 — core chain validated in a real production project (parallel multi-module development, document audits, secret sanitization). See [CHANGELOG.md](../CHANGELOG.md).

## License

MIT (`extensions/subagent/` is derived from pi's official example; original copyright retained)
