---
name: verify-before-claiming
description: |
  How to hand off, and how to receive, a list of claimed defects. Use before applying any
  audit result, review finding, defect list, or "these numbers are wrong" report — and before
  passing such a list to a fixer. Requires re-deriving each value and STOPPING on disagreement
  instead of picking a side.
---

# Verify before claiming

## The scar this skill exists for

Three times while building this repo's architecture doc set, a defect claim was passed to a
fixer without testing its predicate. **All three were wrong.**

1. **"`lib/` is documented as 127,473 lines; should be 127,343."** Both numbers were correct.
   They counted different things: one predicate included `.mjs`, the other did not, and the
   delta was exactly the 130 lines of `import-pptx-worker.mjs`. Applying the "fix" would have
   made a correct figure wrong.
2. **"The per-directory note wrongly claims `.js`/`.mjs` files exist here."** The premise was
   false — `packages/mathml2omml/src` holds 30 `.js` files. The note was accurate.
3. **"Remove the `.trim()` from `slugify`."** A no-op in the claimed case, and removing it
   would have *introduced* a divergence from the reference slugger.

All three were caught for one reason only: the fixer had been instructed to re-derive each
value and **stop on disagreement** rather than trust the list. A fixer that trusts its input
would have shipped three regressions.

## Contract for anyone applying a defect list

1. **Re-derive each value before touching anything.** Run the measurement yourself. The list
   is a hypothesis, not an input.
2. **If your measurement disagrees with the list, STOP and report.** Do not pick the number
   that looks more plausible, do not average, do not silently prefer your own. Report both
   values with the exact command that produced each. Disagreement is the signal that the
   *predicate* is in dispute, and predicates are the thing worth resolving.
3. **Check the predicate before "reconciling" two numbers.** Two numbers can both be right —
   different extension sets, different include/exclude globs, lines vs. entities, tracked vs.
   on-disk files. Ask what each one counts *before* deciding one is wrong. This is defect #1
   above, and it is the most expensive kind of false fix because it corrupts something correct.
4. **Verify the premise, not just the number.** Defect #2 asserted a file class did not exist.
   One `ls` refuted it. When a claim says "X is not true here", check whether X is true here.
5. **A fix you did not watch fail first is not verified.** Reproduce the failure, apply the
   change, watch it pass. A change that produces no observable difference is not a fix — it is
   an unreviewed edit to working code (defect #3).
6. **Report what you did not fix and why.** "Claim 2 not applied: premise false, 30 `.js`
   files present in `packages/mathml2omml/src`" is a finished item, not a skipped one.

## Contract for anyone handing off a defect list

State the predicate with every number, print the command beside it, and tell the fixer
explicitly to re-derive and stop on disagreement. A defect list without predicates is a list
of guesses that reads like a list of facts.

See also `.claude/agents/measurement-auditor.md` (re-running claimed figures) and
`.claude/agents/quantifier-auditor.md` (scope words over controls).
