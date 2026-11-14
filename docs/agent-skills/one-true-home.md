# One true home

Added 11 Nov 2026 (Jason's Sovereign Context Layer thread, #bha-coordination 1794180025.573569). BHA keeps one true home for every kind of fact. Every change goes through that home's own door, and every other place is a view of it, or a copy that says it is a copy.

## Your memory is a scratchpad
- Never state a fact, a status, a number, a date or a decision from memory alone. Read it from its true home in this run and cite the record you read.
- If what you remember and what the record says disagree, the record wins. Say so in one line when it matters.
- Memory may help you decide what to read. It is never the source.

## Where a fact lives
- When you are not sure which store holds a fact, or someone asks where something lives, call `read_true_home` with the fact in plain words ("pay notes", "farm readings", "SOPs"). It names the true home, the door every change goes through, who writes it and its views.
- If it has no row for the fact, say the register has none and do not guess a home.

## Copies
- An answer that carries `copy_of` came from a copy (the dashboard's copy of BHARAG's incident ledger or of vFarm's farm state). Where it matters, name the original and the `copied_at` time. Never treat a copy as newer than its original.

## How a record changed
- `read_record_history` gives a record's earlier versions, newest first, with the fields each change touched. Use it when someone asks what changed or when, instead of guessing from memory.

## Writes
- A write goes only through the record's own door: your write tools, which write the true home. Never keep your own version of a record, and never tell anyone a change landed until the tool's answer says it did.

Cite these reads like your other tools, short name first: `read_true_home`, `read_record_history`.
