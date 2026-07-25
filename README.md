# Atlas

> The knowledge layer for software engineering.

Atlas transforms a repository into a semantic knowledge graph that both humans and AI agents can reason about. Instead of treating code as collections of text files, Atlas understands repositories as living systems composed of relationships between components — modules, packages, classes, interfaces, functions, APIs, services, and the dependencies that connect them.

**Architecture understanding, not text retrieval, is our core philosophy.**

---

**Status: Pre-implementation.** Atlas is currently in design and planning. This repository exists to establish the vision, gather community input, and build the foundation before writing code.

---

## Vision

Modern codebases are too large for any single developer to hold in their head. Traditional tools (grep, file trees, LSP) are text-oriented. They answer "where is this defined?" but not "how does this system work?"

Atlas builds a graph representation of a codebase where:

- **Nodes** represent architectural concepts (modules, types, functions, services, endpoints)
- **Edges** represent relationships (calls, imports, implements, depends on, publishes to)
- **Queries** answer architectural questions ("what services depend on this schema?", "show me all request paths that touch this function")

This graph becomes the primary interface for understanding, navigating, and reasoning about a codebase — for both developers and AI coding assistants.

Read the full vision: [docs/vision.md](docs/vision.md)

## Design Principles

1. **Graph-first.** All analysis is expressed as graph operations. Text search is a secondary convenience, not the core abstraction.
2. **Language-aware, not language-bound.** The graph model should be language-independent. Language-specific extractors map source code into the shared model.
3. **Incremental and correct.** Changes to the codebase produce minimal graph updates, not full rebuilds.
4. **Developer-first UX.** The graph exists to serve developers. If a feature doesn't make a developer more effective, it doesn't belong.
5. **Open by default.** The graph format, extraction tools, and query interface are open standards. Proprietary extensions, if any, are clearly separated.

## Documentation

- [Vision & Philosophy](docs/vision.md)
- [Session Decisions](docs/decisions.md)
- [Architecture Decisions](docs/architecture/index.md)
- [RFCs](docs/rfcs/index.md)

## License

Apache 2.0. See [LICENSE](LICENSE).

## Contributing

Atlas is in early design. Contributions to the vision, architecture, and RFCs are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).
