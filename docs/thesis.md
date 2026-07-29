# Atlas: A Multi-Lens Semantic Index for Software Systems

A technical thesis on the minimal representation required for machine understanding of software systems.

---

## Abstract

Existing representations of software — ASTs, IR, call graphs, code property graphs, LSP indexes — model code at either instruction-level precision or symbol-level granularity. None model the system as a system. None compose structural, temporal, behavioral, and intentional data. None treat uncertainty as first-class. Atlas proposes a fact-based architecture where the representation is a typed, provenance-tracked fact base; a graph is one query-optimized lens among many.

---

## 1. The Problem

### 1.1 What "Understanding" a Software System Requires

A software system is not its source code. Source code is a *specification* of behavior — imprecise, incomplete, and always out of date relative to the running system. A machine that "understands" a software system must answer six classes of question:

| Question Class | Example | Data Required |
|---|---|---|
| Structural | What are the components? | Source code |
| Causal | What depends on X? | Source + call/type resolution |
| Behavioral | What happens when X is called in production? | Runtime traces |
| Intentional | Why does X exist? | Documentation, commits, PRs |
| Temporal | How did X evolve over time? | Version history |
| Counterfactual | What if I change X? | All of the above |

**Source code alone can answer at most 2 of 6 question classes.** Any representation built exclusively from source code — including every representation surveyed in Section 2 — has a hard ceiling: structural comprehension without genuine understanding.

### 1.2 The Gap in Current Tools

Modern codebases are too large for any developer to hold in memory. A mid-size monorepo contains thousands of modules, tens of thousands of functions, and a dependency web that no `grep` can untangle. Our tools have not kept pace.

LLM-based coding assistants have made this worse. They ingest code as flat token sequences, lacking any model of the system's structure or dependencies. They generate functions and explain small scopes but cannot reason about cross-cutting concerns, architectural patterns, or the impact of changes across module boundaries.

The gap is not a missing feature. It is a missing abstraction.

---

## 2. Survey of Existing Representations

Every existing representation was designed for a specific task: compilation, navigation, security analysis, or search. Each is optimal for its original purpose and fundamentally inadequate for system-level understanding.

### 2.1 Compilation-Oriented Representations

**ASTs (Abstract Syntax Trees).** Lossless structural representation of source code. Preserves every token, every position, every syntactic form. ASTs are the input to every downstream analysis. However, ASTs are single-file, language-specific, and encode syntax, not semantics. Two files with the same AST have no connection to each other. ASTs answer "what is the structure of this file?" and nothing more.

**IR (Intermediate Representation) and SSA (Static Single Assignment).** LLVM IR, JVM bytecode, .NET CIL — these represent code at an instruction level optimized for transformation and optimization. SSA makes def-use chains explicit, enabling data-flow analysis. These are the gold standard for soundness. However, they erase architectural concepts entirely. There is no "module" in LLVM IR. There is no "API boundary." They model programs as computation, not as systems. Cross-file analysis requires whole-program compilation, which is expensive and frequently impossible for large projects.

**CFG (Control Flow Graph) and DFG (Data Flow Graph).** CFGs model all possible execution paths through a function. DFGs model how data moves through the program. Both are essential for security analysis and optimization. But they are intraprocedural by nature. Interprocedural extensions (call graphs + CFG = ICFG) are expensive to compute and imprecise in the presence of virtual dispatch, function pointers, and dynamic features. They model execution, not architecture.

**Verdict:** These representations excel at *what happens during execution*. They fail at *what the system is*.

### 2.2 Relationship-Oriented Representations

**Call Graphs.** Nodes are functions, edges are calls. Simple, intuitive, and the foundation of most program analysis. Call graphs answer "what calls what?" But they break down in dynamic languages: virtual dispatch, `eval()`, reflection, and dependency injection make the call graph a near-complete graph in Python or JavaScript. The precision gap is fatal — a call graph where everything potentially calls everything else is no graph at all.

**Code Property Graphs (Yamaguchi et al.)** and **Joern.** CPGs combine AST, CFG, and PDG (Program Dependence Graph) into a unified property graph queryable via Gremlin/Cypher. Joern operationalizes this for security analysis. This is the closest prior art to a general-purpose code graph. It works at scale, supports multiple languages, and answers complex security queries. However, CPGs model code structure, not system architecture. A CPG knows that Function F calls Function G but not that `AuthService` implements `IAuthProvider` and is consumed by `OrderService` via dependency injection. Architectural semantics must be recovered through additional analysis — the CPG is the substrate, not the answer.

**Dependency Graphs (npm, cargo, Maven).** Package-level dependency graphs work at the right granularity for module-level reasoning but have zero visibility below the package boundary. They can tell you that service A depends on library B v2.1.3 but not *which functions* create that dependency or whether the dependency is actually exercised.

**Verdict:** Relationship-oriented representations capture *connections* but not *meaning*. They model code-level links without architectural abstraction. They are also static snapshots with no uncertainty model.

### 2.3 Search-Oriented Representations

**LSP (Language Server Protocol).** LSP servers maintain per-file symbol indexes, providing go-to-definition, find-references, and completion. Ubiquitous, practical, incremental. But LSP is fundamentally file-scoped. It cannot answer "what is the blast radius of changing this API contract?" because that requires cross-file, cross-module transitive analysis that LSP doesn't model.

**SCIP (Sourcegraph Code Intelligence Protocol).** SCIP defines a standard format for code intelligence data: symbols, references, and relationships. It is well-designed, language-agnostic, and deployed at scale. SCIP answers "where is X defined" and "what references X" efficiently. However, SCIP is an index, not an analysis platform. It stores facts but does not compose them. You can find every reference to `UserService.authenticate()` but you cannot ask "show me all call paths from any HTTP handler that reach this authentication function." The data exists in the index; the computation does not.

**Sourcegraph.** Built on SCIP, Sourcegraph provides cross-repository code search with symbol-level intelligence. It is the best available tool for large-scale code navigation. But it remains fundamentally a search engine: you must know what you're looking for. It answers "find" but not "understand."

**Verdict:** These are excellent *indexes* but not *analysis platforms*. They store facts for retrieval but do not compute derived facts, infer architecture, or model uncertainty.

### 2.4 Logic-Oriented Representations

**Datalog and Deductive Databases (CodeQL, Soufflé, DDlog).** Datalog is a declarative logic language where programs are sets of recursive rules. This paradigm is uniquely suited to program analysis: relationships are naturally recursive (transitive dependencies, call chains, data-flow paths), and Datalog evaluates these efficiently. CodeQL demonstrates Datalog at scale for security analysis — millions of lines of code, complex taint-tracking queries.

**What Datalog gets right:**
- Declarative: queries describe *what* you want, not *how* to compute it
- Incrementality (with differential evaluation): new facts produce minimal recomputation
- Recursive queries: transitively closed dependencies are a single line of Datalog
- Composition: multiple analyses compose naturally by sharing predicates

**Where Datalog breaks down:**
- Requires compilation: CodeQL needs the project to build, a catastrophic limitation
- No uncertainty: facts are true or absent, with no intermediate confidence
- No architectural abstraction: facts model code structure, not system intent
- Performance: worst-case complexity for deep recursive queries can be prohibitive

**Differential Datalog** (DDlog, Materialize) adds incremental maintenance — when facts change, derived facts are recomputed efficiently. This is the right computational model for a system that must stay current with a changing codebase.

**Verdict:** Datalog is the strongest computational substrate for program analysis facts. It should be the primary query engine. But it requires a richer fact base than what current Datalog-based tools provide.

### 2.5 Knowledge Graphs

**Neo4j, RDF, Property Graphs.** General-purpose graph databases that store typed nodes and edges. Schema-flexible, queryable via Cypher or SPARQL, well-understood. Several projects (Kythe, snyk, OWASP Dependency-Track) use graph databases for code analysis.

The problem is that these are graph databases, not program analysis platforms. They store edges but have no built-in semantics for data flow, control flow, type resolution, or call resolution. Every piece of program semantics must be manually encoded as graph structure. For large codebases, the graph becomes enormous (billions of edges) and traversal performance degrades without careful denormalization.

**Verdict:** A graph database can store Atlas facts but should not define Atlas's data model. The fact schema exists above the storage layer. The storage engine is an implementation choice, not an architectural decision.

---

## 3. Why "Repository → Graph" Is the Wrong Abstraction

The Atlas vision document proposes: extract a typed, directed, multi-relational graph from source code and use it as the primary representation.

This is the wrong framing. Three reasons.

### 3.1 A Graph Is a Data Structure, Not an Abstraction

Saying "the representation is a graph" is like saying "the representation is a hash table." It describes the implementation, not the semantics. The question is not *what data structure* but *what information* the system stores and *how it reasons over it.*

A graph is one possible projection of the underlying information. A Datalog relation is another projection. An embedding space is a third. The representation is the information, not any single projection of it.

### 3.2 A Graph Imposes a Single Schema

A universal node/edge model forces every fact into the same structure: things connected by typed relationships. But not all relationships are edges:

| Relationship | Graph Model | Better Model |
|---|---|---|
| "This function was changed 3 days ago" | Node property | Temporal fact with timestamp provenance |
| "This dependency is probably unused in production" | Node with confidence property | Fact with probabilistic model |
| "This module's purpose is rate limiting" | Node with `purpose` label | Intent fact in natural language |
| "Control flows from line 42 to line 56" | CFG edge | Part of a CFG region with ordering semantics |

Trying to represent everything as a node/edge graph either flattens these distinctions (losing semantics) or creates a graph so complex it is unqueryable.

### 3.3 A Graph Has No Uncertainty Model

In the graph model, an edge either exists or it doesn't. But static analysis is inherently uncertain:

- Virtual dispatch: only runtime profiling determines actual targets
- Dynamic imports: `import(variablePath)` is statically opaque
- Dependency injection: framework convention determines wiring, not code
- Generated code: the graph must either model the generator or the output
- Dead code: edges exist in the graph but are never traversed

A boolean edge model creates false certainty. Every edge in a purely static graph is an approximation, and downstream consumers have no way to distinguish certain from uncertain edges.

---

## 4. The Atlas Abstraction: Fact-Based Multi-Lens Semantic Index

### 4.1 The Core Idea

A software repository contains latent information across multiple dimensions: structure (what the code says), behavior (what the code does at runtime), intent (what the authors meant), and evolution (how the code changed over time). Atlas makes this information explicit by extracting it as **typed, provenance-tracked facts.**

A fact is a minimal unit of knowledge about the system:

```
Fact {
  id: "f_7a3b2c"
  type: "calls"
  subject: "authenticate"       // canonical entity identifier
  object: "validateToken"       // canonical entity identifier
  confidence: 0.95
  sources: ["static-extractor-v0.1"]
  language: "typescript"
  location: { file: "auth.ts", line: 42 }
  metadata: { inline: false }
}
```

Facts are atomic, typed, versioned, and provenance-tracked. They are the **source of truth** within the Atlas system. The code remains the external source of truth.

### 4.2 Why Facts, Not Graphs

**Uncertainty is first-class.** Every fact has a confidence score. Queries can filter by confidence. "Show me all dependencies I'm certain about" vs. "show me all possible dependencies." Contradictions are resolvable: when a runtime trace contradicts a static analysis fact, the runtime fact has higher confidence.

**Incrementality falls out naturally.** New code → new facts. Changed code → updated facts with new provenance. Deleted code → deprecated facts. Differential Datalog recomputes derived facts efficiently.

**The schema is extensible.** V1 facts: structural and relational. V2 facts: runtime traces. V3 facts: temporal (git history). V4 facts: intent (documentation, PR discussions). The fact base grows without requiring a new data model each time.

**AI consumption is efficient.** Facts are structured, typed, and compact. An LLM can consume 200 typed facts about a module more efficiently than 20,000 tokens of source code. Facts can be chunked, filtered, summarized, and ranked for context windows.

### 4.3 The Multi-Lens Architecture

A single query interface cannot optimally serve all reasoning tasks. Atlas provides multiple **lenses** — query-optimized projections of the fact base — each designed for a specific class of question:

| Lens | Implementation | Answers | Data Source |
|---|---|---|---|
| **Symbol Lens** | SCIP-compatible index | "Where is X defined? Who references X?" | Static facts |
| **Relation Lens** | Differential Datalog | "What transitively depends on X?" | Static + temporal facts |
| **Flow Lens** | Abstract interpretation engine | "What data reaches this sink?" | Static + runtime facts |
| **Intent Lens** | Vector embeddings | "What does this module do?" | Documentation + naming + comments |
| **Temporal Lens** | Git analysis engine | "How did X evolve? Who changed it?" | Version history |
| **Architecture Lens** | Pattern matcher over relations | "What are the actual module boundaries?" | Derived facts from Relation Lens |

Each lens is independently queryable. Cross-lens queries compose through shared entity identifiers.

### 4.4 The Symbol Identity Layer

This is the hardest and most important design decision. Every entity in the system — every function, class, module, interface — must have a stable, unique identifier that survives refactoring.

File paths break when files move. Function names break when functions are renamed. Line numbers break when code shifts. The solution is **content-addressed** identification: hash the entity's definition structure (AST fingerprint), not its location. This is analogous to what stack-graphs does for name resolution and what structural diffing tools (difftastic, gumtree) do for comparing versions.

Entities get a canonical ID of the form:

```
atlas:typescript:fn:sha256:a1b2c3d4...
```

This ID is stable across refactoring (same hash = same entity), across versions (hash captures definition changes), and across extractors (different tools produce the same hash for the same entity). This enables:
- Cross-lens composition (all facts about the same entity share the same ID)
- Incremental update (changed entities get new hashes; unchanged entities retain old hashes)
- Cross-repository linking (entities in different repos can reference each other by ID)

---

## 5. The Hard Problems

### 5.1 The Dynamic Language Wall

In Python, JavaScript, Ruby, and similar languages, static analysis cannot reliably determine call graphs, type relationships, or even module boundaries. Dynamic dispatch, `eval()`, reflection, `getattr`, `Proxy`, monkey-patching — these are not edge cases; they are fundamental language features.

**Approach:** Accept that static analysis alone is insufficient. Atlas must ingest runtime traces for dynamic languages. A runtime profiler that records actual function calls, property accesses, and module imports provides a probability distribution over possible static facts. The fact base stores both: a static fact with confidence 0.4 and a runtime-confirmed fact with confidence 0.95.

### 5.2 The Configuration Problem

Modern systems are data-driven. A Spring Boot application resolves dependency injection at runtime from annotations and XML. A Next.js application determines API routes from file conventions. A Kubernetes deployment defines service topology in YAML. The "architecture" is determined by the framework and its configuration, not by the code alone.

**Approach:** Language extractors must be paired with framework modelers. A framework modeler understands the conventions and annotations of a specific framework and emits the architectural facts that static analysis alone cannot infer. This is a combinatorially large surface area: every framework for every language needs a modeler. The practical approach is to start with the most common frameworks and accept that Atlas will be incomplete for niche frameworks.

### 5.3 The Correctness Trap

Every consumer of Atlas facts will trust them. If the fact base is wrong, every downstream consumer is wrong. In a multi-lens architecture, inconsistencies between lenses become a new class of bug: "The Relation Lens says A depends on B, but the Flow Lens says no data ever reaches B from A." Which is correct? How do you resolve contradictions?

**Approach:** Every fact has provenance. When lenses disagree, the contradiction is a fact itself — a `contradiction` fact with pointers to the conflicting facts. Users (or downstream tools) can query for contradictions, filter by confidence, and decide which to trust. This transforms correctness from a binary property (correct or not) to a graded property (confidence-weighted, with known inconsistencies).

### 5.4 Scale

A large monorepo produces millions of static structural facts. Adding runtime traces, git history, and documentation facts multiplies the fact base by an order of magnitude. Differential Datalog can handle millions of facts in memory, but billions require careful engineering.

**Approach:** The fact base is shardable by module/service boundary. Most architectural queries are scoped to a subset of the system. The query engine should push down filters to the storage layer, not materialize the entire fact base for every query.

### 5.5 The Who-Pays Problem

Atlas is infrastructure. It doesn't ship to end users. Its value is indirect — it makes other tools better. Infrastructure without a direct user pays for itself through developer productivity improvements or tool integration revenue, both of which are hard to quantify and slow to materialize.

**Approach:** This is an organizational problem, not a technical one. The technical credibility of Atlas depends on demonstrating that the fact-based, multi-lens approach enables queries that no existing tool can answer. A compelling demo — "here are 5 questions our CTO asks that nobody can answer today, and here is Atlas answering them" — is the path to organizational buy-in.

---

## 6. Comparison to the Original Vision

| Dimension | Original Vision | Revised Thesis |
|---|---|---|
| Primary abstraction | Graph | Fact base |
| Representation | Node/edge model | Typed, provenance-tracked facts |
| Query model | Graph traversal | Multi-lens (Datalog, index, embeddings, etc.) |
| Uncertainty | Not modeled | First-class confidence scores |
| Incrementality | Stated goal, unaddressed | Natural consequence of fact-based model |
| Source of truth | Graph | Code (external); fact base (internal) |
| AI integration | Deferred | Facts are structured, compact, AI-consumable |
| Cross-lens composition | Not addressed | Shared symbol identity layer |

---

## 7. Recommendations

### 7.1 Abandon "Repository → Graph"

A graph is one projection, not the model. The abstraction is "repository → facts → lenses." This framing is more general, more technically sound, and better aligned with how program analysis systems are actually built.

### 7.2 Build the Fact Engine First

Before designing any query lens, extract structural facts from a real TypeScript codebase. The fact schema will be wrong the first time. That's the point — discover the schema from reality, not from design.

### 7.3 Adopt Datalog as the Primary Query Language

Datalog is the right computational substrate for program analysis. It is declarative, incremental, recursive, and composable. Existing implementations (DDlog, Soufflé) provide production-quality engines. Build Atlas's Relation Lens on Datalog, not on a custom graph traversal language.

### 7.4 Define the Symbol Identity Layer Early

Content-addressed entity identification is the foundation of everything else. Get this right first. Without stable entity IDs, cross-lens composition, incremental update, and cross-repository linking are impossible.

### 7.5 Accept That Static Analysis Is Incomplete

Do not claim that Atlas provides complete, sound analysis. It cannot. Static analysis in dynamic languages is inherently approximate. Instead, make uncertainty explicit and design the system to improve its confidence as more data (runtime traces, documentation, manual annotations) becomes available.

---

## 8. Conclusion

Atlas is technically compelling. The gap it addresses — the absence of a queryable, cross-dimensional representation of a software system — is real and unserved by existing tools. The fact-based, multi-lens architecture is a better abstraction than "repository → graph": it is more general, handles uncertainty naturally, supports incremental growth, and decomposes into independently useful components.

The highest-risk assumption is that a universal symbol identity layer can be made stable across refactoring and language boundaries. The highest-reward design decision is adopting Datalog as the query substrate. The most important thing to build first is a fact extractor for a single language on a real codebase — not a design document, not an ADR, not a graph schema.

The abstraction is worth building. But only if it is built as a fact materialization engine that presents multiple lenses — not as a graph project that happens to read code.
