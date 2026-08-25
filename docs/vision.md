# Vision

> **Superseded (2026-08-21):** this document's central claim — "the graph is the primary representation" — is superseded by [docs/thesis.md](thesis.md), which argues the graph is one query-optimized lens over a fact base, not the source of truth. The problem framing and node/edge catalog below are still useful reference material; the "Graph is the Primary Representation" section is the part to discount. See thesis.md §6 for the point-by-point comparison and [decisions.md](decisions.md) for what this changes about next steps.

Atlas is the knowledge layer for software engineering.

## The Problem

Codebases have grown beyond what any single developer can hold in their head. A mid-size monorepo might contain thousands of modules, tens of thousands of functions, and a web of dependencies that no amount of `grep` can untangle.

Our tools haven't kept up. We still navigate code as if it were text — searching for strings, jumping between files, reading one function at a time. This works for localized changes ("rename this variable") but fails for architectural questions ("what will break if I change this API contract?").

LLMs and AI coding assistants have made this worse, not better. They operate on the same text-based representation, ingesting code as flat token sequences. They can generate functions and explain small scopes, but they don't understand the system. They can't reason about cross-cutting concerns, architectural patterns, or the impact of a change across module boundaries.

## The Gap

Existing tools occupy two extremes:

| Tool | Strength | Limitation |
|------|----------|------------|
| grep / ripgrep | Fast text search | No semantic understanding |
| LSP servers | Symbol-level navigation | File-scoped, no cross-file relationship model |
| IDE "find references" | Call graph within a language | Language-specific, file-oriented, no higher-level concepts |
| Dependency scanners (npm, cargo, etc.) | Package-level graph | No awareness below the package level |
| Sourcegraph / code search | Indexed text/structure search | Still fundamentally text retrieval, not architecture modeling |
| Static analyzers (Semgrep, CodeQL) | Pattern-based queries | Declarative rules, not exploratory understanding |

None of them treat the codebase as a *system* composed of interacting *architectural components*. That's what Atlas aims to do.

## The Model

Atlas represents a codebase as a directed, typed, multi-relational graph.

### Nodes (Things that exist)

| Category | Examples |
|----------|----------|
| **Structural** | Module, Package, Namespace, Crate, Workspace |
| **Declarative** | Class, Interface, Trait, Struct, Enum, TypeAlias, Union |
| **Behavioral** | Function, Method, Constructor, Handler, Middleware |
| **Data** | Table, Schema, Model, DTO, Entity |
| **Interface** | API endpoint, RPC method, Event, Message, Queue |
| **Infrastructure** | Service, Database, Cache, Proxy, LoadBalancer |
| **Meta** | Repository, Commit, Branch, PR |

### Edges (Relationships that connect them)

| Edge Type | Meaning |
|-----------|---------|
| CONTAINS | Module X contains Class Y |
| IMPORTS | Module A imports Module B |
| CALLS | Function F calls Function G |
| IMPLEMENTS | Class C implements Interface I |
| EXTENDS | Class Child extends Class Parent |
| DEPENDS_ON | Service X depends on Service Y |
| PRODUCES | Function F produces Event E |
| CONSUMES | Function G consumes Event E |
| EXPOSES | Service S exposes Endpoint E |
| PERSISTS_TO | Service S writes to Database D |
| RESIDES_IN | Function F lives in File F |

### The Graph is the Primary Representation

This is the fundamental bet. Every query, every visualization, every AI interaction should operate on the graph, not on the text. Text is an input format for building the graph. After construction, the graph is the source of truth.

This opens capabilities that text-based tools cannot provide:

- **Impact analysis**: "Given Function F, traverse all CALLS edges transitively, then find all API endpoints that are reachable. That's the blast radius of changing F."
- **Architecture recovery**: "Cluster nodes by their CONTAINS and IMPORTS edges. The discovered clusters that don't align with directory structure are the actual module boundaries."
- **Dead code detection**: "Nodes with zero inbound CALLS or IMPORTS edges from any live entry point are candidates for removal."
- **Contract enforcement**: "For every Class claiming to IMPLEMENTS Interface I, verify that all REQUIRES edges from I are satisfied."

### What Atlas Is Not

**Not a code search engine.** Text search is a fallback, not the primary interface. If you want "find all files containing `TODO`", use grep.

**Not a static analyzer.** Static analyzers verify properties. Atlas *represents* the system. Verification tools can be built on top of it, but the graph is the foundation.

**Not an IDE replacement.** Atlas doesn't edit code. It doesn't provide completions. It answers questions that IDEs can't.

**Not a language server.** LSPs are per-file, per-language. Atlas is cross-file, cross-language. It reads LSP data where useful but its model is fundamentally different.

## Scope and Phasing

The initial scope is deliberately narrow:

**V1: Static structural graph.** Extract module/package structure, imports, declarations (classes, functions, interfaces), and their containment and call relationships. From source code only. Single-language first (likely TypeScript, then expand).

This is the foundation. Everything else — runtime analysis, infrastructure modeling, cross-service tracing — requires this to be solid first.

### What's Deferred (and Why)

| Feature | V1? | Reason |
|---------|-----|--------|
| Multi-language support | No | Language-independent model must be proven on one language first |
| Runtime/observability data | No | Static analysis is prerequisite for grounding dynamic data |
| Infrastructure modeling | No | Depends on service identification, which depends on module analysis |
| AI-native query interface | No | Graph must be correct before we optimize for LLM consumption |
| Visualization/UI | No | Query API is the interface; visualization is a separate product concern |

## Design Tensions

These are unresolved tensions that need further discussion:

**Graph-first vs. hybrid.** The vision says the graph is primary. But developers live in text editors. If every query requires leaving the editor, adoption will suffer. The likely answer is an LSP-like protocol that surfaces graph answers in-editor, with deeper exploration in a separate interface.

**Language model vs. language plugins.** A universal graph model is elegant. But every language has unique semantics (Rust traits vs. TypeScript interfaces vs. Go embedding). How much of the model is universal, and how much is language-specific extensions? My current leaning: a universal core with typed extension slots.

**Correctness guarantees.** If the graph is wrong, every downstream consumer is wrong. How do we verify extraction correctness? Reference implementations? Test suites? Formal properties? This is the hardest quality problem in the project.

**Graph database choice.** The graph needs to be queryable, persistent, and incrementally updatable. Candidates include: custom in-memory graph (fast, simple, no dependency), SQLite with adjacency (ubiquitous, durable), or embdedded graph DBs like libs/graph. The tradeoff is complexity vs. query expressiveness.

## References

- [Code Property Graphs (Yamaguchi et al.)](https://docs.bernstein.ooo/cpg.pdf) — academic foundation for representing code as graphs
- [stack-graphs (GitHub)](https://docs.rs/stack-graphs/latest/stack_graphs/) — incremental scope graphs for name resolution
- [semantic (GitHub)](https://github.com/github/semantic) — GitHub's code analysis library (abandoned, but instructive)
- [Sourcegraph SCIP](https://github.com/sourcegraph/scip) — code intelligence indexing protocol
