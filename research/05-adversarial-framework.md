# 05 -- Adversarial AI Security Framework: Self-Play for Smart Contract Auditing

## Key Takeaway

Traditional smart contract audits are one-pass, one-perspective reviews. An adversarial self-play framework -- where an attacker agent and a defender agent operate simultaneously against a live contract, with a documenter agent recording every episode -- produces broader coverage, surfaces more creative attack vectors, and generates structured data suitable for training security-focused models. This paper describes the framework architecture, its advantages over single-agent auditing, and the scaling path from 1v1 to multi-agent tournaments.

---

## 1. Motivation

### The Problem with Single-Agent Auditing

Most smart contract security analysis -- whether by humans or AI -- follows a linear pattern:

1. Read the code.
2. Apply known vulnerability patterns (reentrancy, overflow, access control, etc.).
3. Write a report.
4. Move on.

This approach has three structural weaknesses:

**Checklist blindness.** Auditors apply a fixed set of known patterns. Novel attack vectors that do not match existing templates are missed. The 2023 Euler Finance exploit ($197M) used a combination of donation attack and liquidation logic that no standard checklist covered.

**No adversarial pressure.** A single reviewer has no incentive to think creatively about exploitation. They are rewarded for thoroughness against known patterns, not for inventing new ones. The defender mindset ("is this safe?") and the attacker mindset ("how do I break this?") are cognitively different, and a single agent rarely excels at both simultaneously.

**Static analysis of a dynamic system.** Smart contracts on upgradeable proxies (including Diamonds) change over time. A single audit captures one snapshot. Adversarial self-play is continuous -- it tests every state transition, every facet addition, every parameter change.

### Why Self-Play Works

Self-play has a strong track record in AI research for discovering strategies that no single-perspective system would find:

- **AlphaGo / AlphaZero** (Silver et al., 2017): Self-play in Go discovered moves that surprised professional players with millennia of accumulated knowledge.
- **OpenAI Five** (Berner et al., 2019): Self-play in Dota 2 produced coordinated strategies that individual training could not.
- **Cicero** (Meta, 2022): Adversarial negotiation in Diplomacy required modeling opponent strategies, not just optimizing one's own.

The key insight: **an attacker agent that must actually break a contract, not just pattern-match against known vulnerabilities, will explore novel attack paths.** A defender agent that must actually stop a creative attacker, not just apply best practices, will build more robust defenses.

---

## 2. Framework Architecture

### 2.1 Agent Roles

The framework uses three agent roles with strictly separated responsibilities:

```
+------------------+     attacks     +------------------+
|   ATTACKER (Vex) | -------------> |   TARGET         |
|                  |                 |   CONTRACT(S)    |
|  Goal: Break     | <------------- |                  |
|  access controls |   state changes +--------+---------+
+------------------+                         |
        |                                    |
        | reports vector                     | state observable
        v                                    v
+------------------+     records     +------------------+
| DOCUMENTER (Ada) | <------------- |  DEFENDER (Aegis) |
|                  |                 |                   |
|  Goal: Record    |                 |  Goal: Harden     |
|  every episode   |                 |  before exploit   |
+------------------+                 +-------------------+
```

**Attacker (Vex -- Red Team)**
- Objective: Find any way to alter contract state without authorization.
- Constraints: Cannot use the owner's private key. Cannot modify the contract source (only interact via transactions or analysis).
- Strategy space: All vectors from paper 02 (provider injection, eth_call manipulation, meta-transactions, delegatecall context, proxy manipulation, etc.) plus novel vectors discovered during play.
- Output: Exploit attempts (transactions or analysis) with full documentation.

**Defender (Aegis -- Blue Team)**
- Objective: Identify and close vulnerabilities before the attacker exploits them.
- Constraints: Can propose code changes, deploy new facets (for Diamond proxy), or recommend configuration changes. Cannot simply "turn off" the contract.
- Strategy space: Access control hardening, input validation, storage isolation, reentrancy guards, ownership transfer patterns, facet audit.
- Output: Patches, hardening recommendations, and post-mortem analysis.

**Documenter (Ada -- Neutral Observer)**
- Objective: Record every episode with full evidence chain, classify outcomes, and cross-reference findings to research papers.
- Constraints: Does not participate in attack or defense. Reports honestly, including attacker wins.
- Output: Episode files (see `episodes/README.md`), research papers, and aggregate analysis.

### 2.2 Episode Lifecycle

Each episode follows a fixed lifecycle:

```
1. ATTACKER selects a vector and target function
       |
2. ATTACKER executes the attack (on-chain tx or analysis)
       |
3. DEFENDER observes the attack (or independently audits)
       |
4. DEFENDER responds (patch, acknowledge, or explain why existing controls suffice)
       |
5. DOCUMENTER records the episode with:
   - Full attack description
   - Full defense response
   - Outcome classification (ATTACKER_WIN / DEFENDER_WIN / DRAW)
   - Evidence chain (tx hashes, state diffs, code snippets)
   - Key insight
       |
6. DOCUMENTER cross-references to research papers and prior episodes
```

### 2.3 Information Asymmetry

In the current 1v1 configuration, both agents can see all code and all prior episodes. This is a **complete information** game, which simplifies analysis but reduces realism.

Future configurations should explore:

- **Partial information:** Attacker cannot see defender's planned patches until they are deployed. Defender cannot see attacker's planned vectors until they are executed.
- **Timed rounds:** Each agent has a fixed time window to act before the other sees the result.
- **Hidden state:** Some contract state (e.g., pending ownership transfers) is visible only to the owner, requiring the attacker to infer state from observable behavior.

---

## 3. Why Self-Play Beats Single-Agent Auditing

### 3.1 Coverage Comparison

| Dimension | Single-Agent Audit | Adversarial Self-Play |
|-----------|-------------------|-----------------------|
| Known vulnerability patterns | Good (checklist-based) | Good (baseline knowledge) |
| Novel attack vectors | Poor (no incentive to invent) | Good (attacker must innovate) |
| Defense-in-depth testing | Poor (reports once, moves on) | Good (iterative hardening) |
| Upgrade/migration risks | Poor (snapshot in time) | Good (tests each state transition) |
| Combinatorial interactions | Poor (tests functions in isolation) | Good (attacker chains calls) |
| False negatives | High (missed = silent) | Lower (attacker actively probes gaps) |

### 3.2 The Exploration-Exploitation Tradeoff

A single-agent auditor exploits known patterns. They rarely explore novel attack surfaces because there is no feedback loop that rewards creative failure. (If a creative attack attempt fails, the auditor wasted time.)

In self-play, failed attacks are informative. A failed attack that the defender must analyze still produces a useful episode. The attacker is incentivized to try unusual vectors because:

1. Even a failed creative attack may reveal a near-miss that informs a future successful attack.
2. The defender must spend resources analyzing every attempt, creating pressure.
3. The episode record captures the attempt for future analysis, even if it fails now.

### 3.3 Concrete Example: Diamond Proxy

Consider the Diamond proxy at `0x0D5d767Dfad78a81237bCa60d986d68bffE9B174`.

A single-agent audit would check:
- Is `diamondCut` access-controlled? (Yes, `onlyOwner`)
- Is `transferOwnership` access-controlled? (Yes, `onlyOwner`)
- Are there reentrancy risks? (Need to check)
- Is storage isolated correctly? (Need to check)

An adversarial self-play would additionally explore:
- Can the attacker add a malicious facet by exploiting selector collision? (Novel vector)
- Can the attacker call `diamondCut` through a chain of delegatecalls that shifts `msg.sender` context? (Combinatorial)
- Can a facet's self-destruct leave the Diamond in an inconsistent state? (State transition)
- Can the attacker front-run a legitimate `diamondCut` with a conflicting selector? (Timing)
- Can a malicious facet write to Diamond storage slots that another facet reads as trusted? (Cross-facet interference)
- Does `transferOwnership` lack two-step confirmation, enabling a single-tx takeover if the owner's key is ever used in a phishing context? (Protocol-level weakness)

The attacker agent is motivated to try ALL of these. The single-agent auditor may stop after confirming the standard checks pass.

---

## 4. Generating Training Data from Episodes

### 4.1 Data Structure

Each episode produces a structured record:

```json
{
    "episode_id": 1,
    "date": "2026-05-27",
    "target_contract": "0x0D5d...",
    "target_function": "diamondCut(address,bytes4[],uint8)",
    "attack_vector": "Selector collision via crafted function signature",
    "attack_category": "B3",
    "defense_response": "Existing onlyOwner modifier blocks unauthorized diamondCut calls",
    "outcome": "DEFENDER_WIN",
    "state_changed": false,
    "access_bypassed": false,
    "severity": "INFO",
    "key_insight": "Selector collision is a theoretical risk but requires owner-level access to exploit via diamondCut, making it a second-order concern behind ownership security."
}
```

### 4.2 What a Security Model Could Learn

Given N episodes, a model could learn:

1. **Attack vector classification:** Given contract source code, predict which attack categories (A1-C3) are applicable.
2. **Vulnerability scoring:** Given a function's source and its access controls, estimate the probability of a successful attack.
3. **Defense recommendation:** Given an attack vector, recommend the minimal code change to block it.
4. **Priority ordering:** Given multiple potential vulnerabilities, rank them by exploitability and impact.
5. **Novel vector generation:** Given a contract architecture (simple, proxy, Diamond), generate plausible attack vectors not in the training set.

### 4.3 Minimum Viable Dataset

Based on machine learning conventions for structured classification:

- **10 episodes:** Enough to validate the episode format and identify obvious data quality issues. Not enough for any learning.
- **100 episodes:** Enough for basic pattern analysis. Can identify which attack categories are most common and which contract patterns are most vulnerable.
- **1,000 episodes:** Enough to train a simple classifier (attack category given contract features). Requires multiple contracts and architectures.
- **10,000+ episodes:** Enough for fine-tuning a language model on security-specific reasoning. Requires diverse contract types and multi-step attack chains.

### 4.4 Data Quality Requirements

Episode data is only useful if it meets these standards:

- **Reproducibility:** Every episode must include enough information to reproduce the result (contract address, function signature, calldata, block number).
- **Honest outcomes:** Attacker wins must be recorded with the same rigor as defender wins. If the lab only records defender wins, the data is useless for training.
- **Negative results:** Failed attacks are as valuable as successful ones for training. A model needs to learn what does NOT work, not just what does.
- **Minimal confounds:** Each episode tests ONE vector. If an episode combines multiple attack strategies, the outcome is ambiguous.

---

## 5. Comparison to Existing Approaches

### 5.1 Traditional Audits (Trail of Bits, OpenZeppelin, Consensys Diligence)

| Aspect | Traditional Audit | Adversarial Self-Play |
|--------|-------------------|----------------------|
| Cost | $50k-$500k per audit | Compute cost only (local GPU) |
| Duration | 2-8 weeks | Continuous |
| Perspective | Single team, single pass | Two competing agents, iterative |
| Output | PDF report | Structured episode data + papers |
| Upgradeable contract coverage | Snapshot only | Tests each upgrade |
| Novel vector discovery | Depends on auditor creativity | Structurally incentivized |
| Formal verification | Sometimes included | Not included (future work) |

**Key advantage of traditional audits:** Human auditors have domain expertise, intuition about economic incentives, and can reason about MEV/flashloan attacks that pure code analysis misses. They also carry reputational accountability.

**Key advantage of self-play:** Cost, continuity, and structured output. A self-play framework running on local compute can test 100x more vectors than a time-boxed human audit.

These are complementary. The ideal pipeline: self-play framework identifies candidate vulnerabilities, human auditors verify the serious ones.

### 5.2 Automated Tools (Slither, Mythril, Echidna)

| Tool | Method | Strengths | Weaknesses |
|------|--------|-----------|------------|
| Slither | Static analysis (IR) | Fast, good at known patterns | No dynamic behavior, no state reasoning |
| Mythril | Symbolic execution | Can find deep bugs | Slow, path explosion, no cross-contract |
| Echidna | Property-based fuzzing | Finds unexpected states | Requires manually written invariants |
| Adversarial self-play | Agent-based reasoning | Novel vectors, continuous, adaptive | No formal guarantees, depends on agent quality |

Self-play is not a replacement for formal tools. It occupies a different niche: **creative exploration of the attack surface**, particularly for architectural patterns (proxies, Diamonds) where the attack surface is defined by the interaction between components, not by individual function bugs.

### 5.3 Bug Bounties (Immunefi, Code4rena)

Bug bounties are the closest existing analog to adversarial self-play: they incentivize creative attacker thinking. The key differences:

- **Bug bounties require human participants** who must be recruited, motivated, and paid.
- **Self-play is continuous** -- it does not wait for a bounty program to open.
- **Bug bounty reports are unstructured** -- each researcher writes in their own format. Episodes have a fixed schema.
- **Bug bounties have a single direction** -- attackers only. Self-play includes the defensive response.

---

## 6. Scaling Path

### 6.1 Current: 1v1 (Vex vs. Aegis)

One attacker agent, one defender agent, one documenter. All agents see all information. Episodes are sequential.

**Limitations:**
- Single attacker perspective limits creative diversity.
- No pressure on the defender from simultaneous multi-vector attacks.
- Complete information eliminates the need for reconnaissance.

### 6.2 Near-Term: 3v3

Three attacker agents with different specializations:
- **Protocol attacker:** Focuses on ECDSA, tx format, msg.sender derivation.
- **Architecture attacker:** Focuses on proxy patterns, delegatecall, storage slots.
- **Economic attacker:** Focuses on MEV, front-running, flash loans, incentive manipulation.

Three defender agents with different specializations:
- **Access control defender:** Focuses on ownership, roles, modifiers.
- **State integrity defender:** Focuses on storage layout, reentrancy, invariants.
- **Operational defender:** Focuses on monitoring, alerting, incident response.

**Benefit:** Specialization enables deeper exploration of each attack category. Cross-agent coordination tests whether defenses are consistent across perspectives.

### 6.3 Long-Term: 10v10 Tournament

Ten attacker agents compete to find vulnerabilities. Ten defender agents compete to be the first to patch them. Agents are ranked by:

- **Attacker score:** Number of ATTACKER_WIN episodes, weighted by severity.
- **Defender score:** Number of DEFENDER_WIN episodes + speed of patch deployment.

Tournament dynamics introduce:
- **Arms race pressure:** Each successful attack forces all defenders to improve.
- **Red queen effect:** Attackers must continually innovate because defenders close known vectors.
- **Ensemble coverage:** Ten different attacker strategies cover more of the attack surface than any single strategy.

### 6.4 Infrastructure Requirements

| Scale | Agents | Episodes/Day (est.) | Compute | Data per Month |
|-------|--------|---------------------|---------|---------------|
| 1v1 | 3 (atk+def+doc) | 5-10 | 1 GPU, local | ~50 episodes |
| 3v3 | 9 (3+3+3) | 20-50 | 1 GPU, local | ~500 episodes |
| 10v10 | 23 (10+10+3 doc) | 100-500 | Multi-GPU or cloud | ~5,000 episodes |

---

## 7. Limitations and Open Questions

### 7.1 Known Limitations

1. **Agent quality ceiling.** Self-play is only as good as the agents. If the attacker agent cannot reason about storage slot collisions, it will never discover that attack vector. The framework does not magically generate expertise -- it structures the application of existing expertise.

2. **No formal guarantees.** Unlike symbolic execution or formal verification, self-play cannot prove the absence of vulnerabilities. It can only demonstrate the presence of specific ones.

3. **Compute-bounded exploration.** The attack surface of a Diamond proxy is combinatorially large (every facet x every function x every state x every caller). Self-play explores a sample, not the full space.

4. **Economic reasoning gap.** Current agents reason about code, not about economic incentives. MEV extraction, flash loan attacks, and governance manipulation require modeling rational agents with financial incentives, which is a harder problem.

### 7.2 Open Questions

1. **Optimal attacker/defender ratio.** Is 1:1 the right balance, or do more attackers per defender produce better coverage?
2. **Information structure.** Does partial information (attacker cannot see defender's patches in advance) produce more realistic and useful episodes?
3. **Transfer learning.** Do episodes from one contract type (simple onlyOwner) help an agent find vulnerabilities in a different type (Diamond proxy)?
4. **Convergence.** Does the attacker-defender game converge to a stable equilibrium, or does it oscillate? If it converges, is the equilibrium state actually secure?
5. **Validation against known exploits.** Can the framework independently rediscover known historical exploits (Euler, Ronin, Wormhole) when given the pre-exploit contract code?

---

## 8. Conclusion

Adversarial self-play for smart contract security is a natural extension of two well-established ideas: red team/blue team exercises in cybersecurity, and self-play in AI research. The contribution of this framework is structural: a fixed episode format, a clear agent role separation, and a scaling path from 1v1 to tournament-scale.

The immediate value is better security coverage for THRYX's Diamond proxy contracts. The long-term value is a structured dataset of attack/defense episodes that could train specialized security models.

The framework is not a replacement for formal verification, professional audits, or automated static analysis tools. It is a complement -- one that is particularly well-suited to upgradeable, modular contract architectures where the attack surface changes with every deployment.

---

## References

1. Silver, D. et al. "Mastering the game of Go without human knowledge." Nature 550, 354-359 (2017).
2. Berner, C. et al. "Dota 2 with Large Scale Deep Reinforcement Learning." arXiv:1912.06680 (2019).
3. Meta Fundamental AI Research Diplomacy Team. "Human-level play in the game of Diplomacy by combining language models with strategic reasoning." Science 378, 1067-1074 (2022).
4. EIP-2535: Diamonds, Multi-Facet Proxy -- https://eips.ethereum.org/EIPS/eip-2535
5. Trail of Bits. "Building Secure Smart Contracts." https://github.com/crytic/building-secure-contracts
6. Consensys Diligence. "Ethereum Smart Contract Best Practices." https://consensys.github.io/smart-contract-best-practices/
7. Immunefi. "Web3 Bug Bounty Platform." https://immunefi.com/
8. Mossberg, M. et al. "Manticore: A User-Friendly Symbolic Execution Framework for Binaries and Smart Contracts." ASE 2019.
9. Grieco, G. et al. "Echidna: Effective, Usable, and Fast Fuzzing for Smart Contracts." ISSTA 2020.
10. Feist, J. et al. "Slither: A Static Analysis Framework for Smart Contracts." WETSEB 2019.
