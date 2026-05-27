# Adversarial Episode Tracking

## Purpose

This directory records every attacker-vs-defender episode in the SpoofWallet adversarial security lab. Each episode captures a single attack vector attempt and the corresponding defensive response. Over time, the episode log builds a structured dataset of smart contract attack/defense patterns suitable for analysis, training, or publication.

## Episode Format Specification

Every episode is a single Markdown file named `episode-NNN.md` where NNN is zero-padded to three digits (e.g., `episode-001.md`).

### Required Fields

```markdown
# Episode NNN: <Short Descriptive Title>

**Date:** YYYY-MM-DD
**Attacker agent:** <name or ID>
**Defender agent:** <name or ID>
**Target contract:** <address> on <network>
**Target function:** <function signature>

## Attacker Vector

<1-3 paragraph description of the attack strategy. Include the
specific mechanism, not just "tried to exploit the contract.">

### Attack Code / Transaction

<Code snippet, tx hash, or calldata used in the attempt.
If analysis-only (no on-chain tx), state that explicitly.>

## Defender Response

<What the defender did: identified the vector, proposed a fix,
deployed a patch, or determined the existing code was already safe.>

### Defense Code / Evidence

<Code snippet of the fix, tx hash of the patched deployment,
or reference to the specific access control that blocked the attack.>

## Outcome

**Result:** ATTACKER_WIN | DEFENDER_WIN | DRAW

- ATTACKER_WIN: The attacker successfully altered contract state,
  bypassed an access control, extracted funds, or demonstrated a
  viable exploit path that was not blocked by existing defenses.
- DEFENDER_WIN: The attack was blocked by existing controls, or
  the defender patched the vulnerability before the attacker could
  exploit it.
- DRAW: The attack revealed a theoretical weakness that does not
  have a practical exploit path under current conditions, or the
  attack and defense were simultaneous.

**State change achieved:** YES / NO
**Access control bypassed:** YES / NO
**Funds at risk:** <amount in ETH/USD or NONE>

## Evidence Chain

| Item | Value |
|------|-------|
| Attack tx hash | `0x...` or N/A (analysis only) |
| Defense tx hash | `0x...` or N/A |
| Block number | ... or N/A |
| Contract state before | <relevant storage values> |
| Contract state after | <relevant storage values> |
| Basescan verification | <URL or N/A> |

## Key Insight

<1-3 sentences: What did this episode teach us that we did not
know before? What general principle does it illustrate?>

## Cross-References

- Related episodes: [episode-NNN](episode-NNN.md)
- Research paper: [0X-paper-name](../0X-paper-name.md)
- Contract source: `contracts/<path>`
```

### Outcome Classification Rules

1. If the attacker changes ANY contract state they should not have been able to change, the outcome is ATTACKER_WIN regardless of the severity.
2. If the attacker demonstrates a path that WOULD work given different conditions (e.g., "if the owner called this malicious contract"), classify as DRAW and document the preconditions.
3. If the attack is purely theoretical with no on-chain evidence and no viable execution path, classify as DEFENDER_WIN.
4. When in doubt, favor the attacker. The purpose of the lab is to find vulnerabilities, not to declare victory.

### Severity Tags (Optional)

Add severity tags in the episode title when applicable:

- `[CRITICAL]` -- Direct fund extraction or ownership takeover
- `[HIGH]` -- Access control bypass on state-changing functions
- `[MEDIUM]` -- Information leak, griefing, or denial of service
- `[LOW]` -- UI-only deception, no on-chain impact
- `[INFO]` -- Educational finding, no vulnerability

## Episode Index

Episodes are tracked both here and in the main research README.

| Episode | Date | Vector | Outcome | Severity |
|---------|------|--------|---------|----------|
| *none yet* | | | | |

## Aggregation Queries

After accumulating episodes, these are the useful aggregate questions:

1. **Win rate by contract type:** Do Diamond proxies have a higher attacker win rate than simple contracts?
2. **Vector frequency:** Which attack categories (A/B/C from paper 02) produce the most episodes?
3. **Time-to-defend:** How many blocks/minutes between attack and defensive response?
4. **Patch effectiveness:** Do defender patches introduce new attack surfaces?
5. **Coverage gaps:** Which functions have never been attacked? Those are the blind spots.

## File Naming Convention

- `episode-001.md` through `episode-999.md` -- sequential, never reused
- `summary-YYYY-MM.md` -- monthly summaries (created when episode count > 10)
- `analysis-<topic>.md` -- cross-episode analysis documents
