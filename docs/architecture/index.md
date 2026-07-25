# Architecture Decision Records

Architecture Decision Records (ADRs) document significant design decisions, the context in which they were made, and their consequences. Each ADR is immutable once accepted — corrections go in a new ADR.

## Active ADRs

*None yet. Proposals welcome.*

## Template

See [template.md](template.md).

## Process

1. **Propose.** Open a GitHub Discussion with the ADR template. Use the "RFCs" category.
2. **Discuss.** The proposal is debated in the open. Minimum one week for comment.
3. **Decide.** A maintainer accepts, rejects, or requests changes.
4. **Record.** Accepted ADRs are committed here with a numeric prefix (`0001-use-sqlite.md`).

## What Qualifies as an ADR?

Anything that is:
- Architecturally significant (affects the graph model, extraction pipeline, or query API)
- Hard to reverse (database choice, serialization format, plugin architecture)
- Contested (there are multiple reasonable approaches)

Not an ADR:
- Bug fixes
- Implementation details that don't affect the architecture
- Performance optimizations (unless they change the data model)
- Tooling choices (linter, formatter, test runner)
