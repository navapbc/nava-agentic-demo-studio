# Story architecture

## Start with the audience change

Write these five statements before outlining slides:

1. **Audience:** who is in the room and what they already know.
2. **Starting belief:** the assumption or incomplete picture they bring.
3. **Leaving belief:** the sharper interpretation the evidence should support.
4. **Decision:** what they should fund, test, approve, question, or carry forward.
5. **Ending insight:** the fact or synthesis that reorganizes the story.

The deck thesis should connect the work to the audience's decision. It is not a title or slogan.

## Build an earned ending

A strong strategy or progress deck often moves through these functions, though not every deck needs one slide per function:

- establish the original problem or moment of transition;
- show what the earlier phase proved and what it exposed;
- name the constraint that shaped the next work;
- present progress as evidence, not a feature inventory;
- show how the pieces combine into a broader capability;
- pose the last unresolved constraint;
- reveal the new evidence or technical change;
- explain the practical implications and the next decision.

Place the most surprising implication late enough to feel earned. Foreshadow it through the constraint it resolves. Do not hide a necessary caveat until after the reveal.

Before writing the closing ask, refresh the current relationship and opportunity constraints. A completed pilot does not establish that the same partner is available for the next engagement. Name the prospective buyer, the value they would receive, the route to reach them, and the proof needed to earn a contract. Present possible partners as candidates until there is evidence of commitment. When a portfolio strategy is requested, connect the capability to that portfolio's workflows rather than making a former pilot partner a prerequisite.

## Give every slide a job

Useful narrative roles include cover, orientation, context, tension, mechanism, proof, comparison, lived experience, synthesis, setup, reveal, implications, decision, and appendix. Two neighboring slides may share a role only when they advance distinct evidence.

Ask of every slide:

- What does the audience understand after this slide that they did not understand before it?
- Why is this the next slide?
- Could the main point survive if half the words disappeared?
- Does the visual prove, explain, or merely decorate?

## Slide-plan JSON

Use this structure so the audit script can check the plan:

```json
{
  "deck": {
    "audience": "Named audience and context",
    "purpose": "Why the presentation exists",
    "decision": "The decision or reaction requested",
    "starting_belief": "What the audience likely believes now",
    "leaving_belief": "What the evidence should change",
    "thesis": "The argument connecting evidence to the decision",
    "ending_aha": "The late insight that reorganizes the story",
    "source_boundary": "What sources and caveats bound the claims"
  },
  "slides": [
    {
      "number": 1,
      "role": "cover",
      "title": "Plain title",
      "claim": "The one point or subject",
      "evidence": "Evidence shown or explained",
      "visual_concept": "The visual that carries the idea",
      "composition": "image-led split",
      "evidence_scope": "Population, task boundary, time period, and caveat needed to interpret the evidence",
      "comparison_basis": "Same unit and denominator, or an explicit statement that the stages are directional rather than like-for-like",
      "layout_intent": {
        "dominant_region": "What owns the most visual weight",
        "supporting_region": "What explains or qualifies it",
        "blank_space_role": "What the unoccupied region is doing; use none when the canvas is fully assigned"
      },
      "transition": "Why the following slide is next",
      "source_refs": ["source-id or local path"],
      "body_word_count": 0
    }
  ]
}
```

Use `body_word_count` for visible body copy, excluding the title and source note. When it is omitted, the audit script estimates from the claim and evidence fields.

## Evidence and caveats

Keep the distinction between proven, observed, inferred, proposed, and required-next-step visible in the wording. A prototype result should not become a production claim. If a number needs an explanation to remain honest, either show the explanation concisely or put it in the speaker notes and signal the boundary on the slide.

For any comparison, record the task boundary, unit, denominator, time period, and relevant architecture. Do not place session cost, per-application cost, prototype fixture cost, and marginal API cost on one scale unless the slide explicitly explains the boundary. When evidence is directional but not like-for-like, use separate stages or case studies and say so.
