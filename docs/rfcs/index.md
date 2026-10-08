# RFCs

RFCs (Request for Comments) are the mechanism for proposing and discussing significant changes to Atlas.

## Active RFCs

*None yet.*

## Process

1. **Open a Discussion.** Start a GitHub Discussion in the "RFCs" category. Use the [template](template.md).
2. **Gather feedback.** RFCs are open for at least one week. The goal is to surface objections, alternatives, and edge cases — not to reach consensus.
3. **Decision.** A maintainer accepts (moves to implementation), rejects, or requests revision. The decision includes a written rationale.
4. **Implementation.** Accepted RFCs generate tracking issues for implementation. The RFC text is committed here.

## When to Write an RFC

Write an RFC when the change:
- Changes the fact schema (new fact kinds or entity id form, new semantics)
- Introduces or changes a public API
- Changes the extraction or query pipeline architecture
- Has significant performance or correctness implications

Don't write an RFC for:
- Bug fixes
- Documentation improvements
- Straightforward features that don't affect the architecture

## Tips

- **Be concrete.** Include examples, sample queries, and API sketches.
- **Compare alternatives.** Show your work. What did you consider and reject?
- **Address downsides.** Every design has tradeoffs. Name them.
- **Think about migration.** How do existing users adopt this change?
