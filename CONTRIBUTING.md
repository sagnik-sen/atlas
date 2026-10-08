# Contributing to Atlas

Atlas is in early design. The most valuable contributions right now are ideas, design feedback, and RFC discussions — not code.

## Ways to Contribute

### Design & Vision
Read [docs/thesis.md](docs/thesis.md) first — it is the governing model; [docs/vision.md](docs/vision.md) is kept for its problem framing but its graph-first claim is superseded. If you have thoughts on the fact schema, the query interface, the extraction approach, or the scope, open a discussion. The most impactful conversations we can have right now are about what *not* to build.

### RFCs
Significant design proposals follow the RFC process. See [docs/rfcs/index.md](docs/rfcs/index.md) for the process and [docs/rfcs/template.md](docs/rfcs/template.md) for the template.

### Architecture Decisions
When a design decision has been debated and resolved, it should be captured as an Architecture Decision Record (ADR). See [docs/architecture/index.md](docs/architecture/index.md).

### Code
We're not accepting production code contributions yet — the core architecture (fact schema, symbol identity, query lenses) isn't settled. Throwaway validation prototypes like `prototype/` are in scope and encouraged: they exist to test hypotheses against real codebases before writing an ADR, not to ship. See [docs/thesis.md](docs/thesis.md) §7.2.

## Design Discussions

- **Be concrete.** Show examples, sketch APIs, write pseudo-code.
- **Compare alternatives.** Every proposal should include the options you rejected and why.
- **Think about the facts.** What typed facts does your idea need, and can both endpoints of every edge it implies be resolved to a declared entity? A graph is one lens over the fact base, not the model.
- **Consider incremental adoption.** Can a developer use this without rewiring their entire workflow?

## Communication

- Use GitHub Discussions for open-ended design conversations.
- Use GitHub Issues for concrete, actionable proposals with a clear scope.
- RFCs are the heavyweight process for major architectural changes.

## Values

- **Depth over breadth.** A fact schema that correctly handles 3 languages is better than a shallow model for 20.
- **Correctness over speed.** The fact base must be trustworthy, and every extraction run asserts its own invariants. Fast-but-wrong is worse than slow-but-right — four findings in this project's record turned out to be extractor bugs rather than facts about static analysis.
- **Composable over monolithic.** Extensions and language support should be pluggable, not baked in.
- **Honest about limitations.** Documenting what Atlas *cannot* do is as important as documenting what it can.
