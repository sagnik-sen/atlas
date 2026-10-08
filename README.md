# Atlas

> The knowledge layer for software engineering.

Atlas turns a repository into a typed, provenance-tracked fact base that both humans and AI agents can reason about, queried through several lenses — one of which is a graph. Instead of treating code as collections of text files, Atlas understands repositories as living systems composed of relationships between components — modules, packages, classes, interfaces, functions, APIs, services, and the dependencies that connect them.

**Architecture understanding, not text retrieval, is our core philosophy.**

---

**Status: Design, with a throwaway prototype.** No production code. `prototype/` holds a ts-morph fact extractor used to test the design against a real codebase; see [prototype/report.md](prototype/report.md) for measured results and [docs/architecture/0001-fact-schema.md](docs/architecture/0001-fact-schema.md) for the schema it grounds.

---

## Vision

Modern codebases are too large for any single developer to hold in their head. Traditional tools (grep, file trees, LSP) are text-oriented. They answer "where is this defined?" but not "how does this system work?"

Atlas extracts a fact base from a codebase. Projected as a graph, it reads as:

- **Nodes** represent architectural concepts (modules, types, functions, services, endpoints)
- **Edges** represent relationships. The prototype emits `calls`, `instantiates`, `references`, `imports`, `reexports`, `extends`, `implements` and `contains`
- **Queries** answer architectural questions ("what services depend on this schema?", "show me all request paths that touch this function")

The fact base is the primary representation; a graph is one query lens over it. See [docs/thesis.md](docs/thesis.md).

Read the full vision: [docs/vision.md](docs/vision.md). Note: [docs/thesis.md](docs/thesis.md) supersedes the vision's "graph is primary" framing — the graph is now one query lens over a typed fact base, not the source of truth. See thesis.md for the current governing model and [docs/decisions.md](docs/decisions.md) for what that changes about next steps.

## Design Principles

1. **Fact-first.** All analysis is expressed as typed, provenance-tracked facts. The graph is one query lens over the fact base, not the core abstraction — see [docs/thesis.md](docs/thesis.md).
2. **Language-aware, not language-bound.** The fact schema should be language-independent. Language-specific extractors map source code into the shared schema. (Entity ids are currently TypeScript-only — see [docs/decisions.md](docs/decisions.md) open tension #2.)
3. **Incremental and correct.** Changes to the codebase should produce minimal fact updates, not full rebuilds. Not yet implemented: there is no incremental run.
4. **Developer-first UX.** Atlas exists to serve developers. If a feature doesn't make a developer more effective, it doesn't belong.
5. **Open by default.** The fact schema, extraction tools, and query interface are open standards. Proprietary extensions, if any, are clearly separated.

## Documentation

- [Vision & Philosophy](docs/vision.md) (superseded framing, see thesis)
- [Thesis: Fact-Based Multi-Lens Index](docs/thesis.md) (current governing model)
- [Session Decisions](docs/decisions.md)
- [Architecture Decisions](docs/architecture/index.md)
- [RFCs](docs/rfcs/index.md)

## License

Apache 2.0. See [LICENSE](LICENSE).

## Contributing

Atlas is in early design. Contributions to the vision, architecture, and RFCs are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).
