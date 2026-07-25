# Contributing to Atlas

Atlas is in early design. The most valuable contributions right now are ideas, design feedback, and RFC discussions — not code.

## Ways to Contribute

### Design & Vision
Read [docs/vision.md](docs/vision.md). If you have thoughts on the graph model, the query interface, the extraction approach, or the scope, open a discussion. The most impactful conversations we can have right now are about what *not* to build.

### RFCs
Significant design proposals follow the RFC process. See [docs/rfcs/index.md](docs/rfcs/index.md) for the process and [docs/rfcs/template.md](docs/rfcs/template.md) for the template.

### Architecture Decisions
When a design decision has been debated and resolved, it should be captured as an Architecture Decision Record (ADR). See [docs/architecture/index.md](docs/architecture/index.md).

### Code (Not Yet)
We are not accepting code contributions at this stage. The implementation will begin once the core architecture is well-defined. This prevents wasted work from misaligned assumptions.

## Design Discussions

- **Be concrete.** Show examples, sketch APIs, write pseudo-code.
- **Compare alternatives.** Every proposal should include the options you rejected and why.
- **Think about the graph.** Does your idea express naturally as graph operations? If not, why?
- **Consider incremental adoption.** Can a developer use this without rewiring their entire workflow?

## Communication

- Use GitHub Discussions for open-ended design conversations.
- Use GitHub Issues for concrete, actionable proposals with a clear scope.
- RFCs are the heavyweight process for major architectural changes.

## Values

- **Depth over breadth.** A graph model that correctly handles 3 languages is better than a shallow model for 20.
- **Correctness over speed.** The graph must be trustworthy. Fast-but-wrong is worse than slow-but-right.
- **Composable over monolithic.** Extensions and language support should be pluggable, not baked in.
- **Honest about limitations.** Documenting what Atlas *cannot* do is as important as documenting what it can.
