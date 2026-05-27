# Spoof Wallet — Adversarial AI Security Lab

Adversarial AI agents competing on live smart contracts. Attacker agents vs defender agents, with a documenter tracking every round. Deployed on Base mainnet with real tokens at stake.

**Live Dashboard**: [lordbasilaiassistant-sudo.github.io/SpoofWallet](https://lordbasilaiassistant-sudo.github.io/SpoofWallet/)

## The Novel Contribution

The individual bugs we found are mostly known patterns — the real contribution is the **methodology**:

- **Adversarial self-play** finds cross-facet interaction bugs that checklist-style audits miss
- **Independent verification** prevents inflated findings — a third agent brutally validates each discovery against production contracts
- **Structured episodes** generate data that could train security-focused models
- **On-chain verification** (not just source review) catches bugs that static analysis tools don't

The attacker agent's Round 1 checklist found 3 LOW issues. The defender found 13 including 1 CRITICAL. When forced to read each other's work in Round 2, both teams found cross-facet bugs that neither would have found alone. That's the point.

## Findings (Honestly Verified)

Every finding was independently verified against production contracts. We categorize honestly:

| Finding | Severity | Verdict | Notes |
|---------|----------|---------|-------|
| diamondCut missing extcodesize | CRITICAL | **KNOWN** | Reference EIP-2535 includes this check. We omitted it. |
| claimFees reentrancy | HIGH | **MIXED** | Real bug, known pattern. Percentage-of-remainder amplification is semi-novel. |
| Critical selector removal unprotected | HIGH | **MIXED** | Nick Mudge reference also lacks this. Under-protected in the Diamond standard. |
| Single-step ownership transfer | HIGH | **KNOWN** | Standard recommendation. Most DeFi TVL still uses single-step. |
| Timelock bypass (3 write paths) | — | **OUR_FAULT** | We built the bypass ourselves. No production contract does this intentionally. |
| Dual ETH accounting | — | **OUR_FAULT** | Amateur architecture — two ledgers on one contract. |
| TOCTOU race on pending fee recipient | MEDIUM | **OUR_FAULT** | Stale pending change reverts a direct change. Our design flaw. |
| 20% ETH permanently locked | MEDIUM | **OUR_FAULT** | No withdrawal path for protocol-retained share. |
| Operator uncapped withdrawal | MEDIUM | **MIXED** | Real pattern — many protocols give operators too much authority. |

**Bottom line**: 2 MIXED findings with partial production relevance, 2 KNOWN issues we should have avoided, 4 self-inflicted design flaws. Zero novel zero-days. The security boundary for `msg.sender` is cryptographic (secp256k1) — confirmed across 18+ attack vectors.

## What Actually Matters: The Core Research Question

**Can browser-level wallet spoofing bypass on-chain access controls?**

**Answer: No.** `msg.sender` is derived from `ecrecover(txHash, v, r, s)` — ECDSA signature recovery. No browser extension, provider injection, or RPC manipulation can alter it. This is a cryptographic guarantee, not a software assumption. Confirmed with:
- 18 attack vectors tested against live Diamond proxy
- `eth_call` simulation spoofing (works at UI level, zero state change on-chain)
- Real transaction attempts from non-owner wallets (all reverted)
- ERC-2771 meta-transaction analysis (would work IF contract uses `_msgSender()` — ours doesn't)

## Deployed Contracts (Base Mainnet)

| Contract | Address | Purpose |
|----------|---------|---------|
| Diamond Proxy | `0x0D5d767Dfad78a81237bCa60d986d68bffE9B174` | EIP-2535 proxy with delegatecall routing |
| DiamondCutFacet | `0x2523cec75f2eE829f65A3eDAE49E12976f414c07` | Upgrade mechanism, ownership |
| ChallengeFacet | `0x7c6634E064F2b7148b0896EC93dBBe9b7Ee824CE` | Fee recipient, spoof flag, operators, treasury |
| ERC20Facet | `0xA9ff28e46e2e7CB45369152784413934e1E527f3` | SPOOF token (1B supply) |
| BountyFacet | `0x89D55CB0d9b62028f37E6bd0294ce263ee4e73e6` | Exploit submission + reward system |
| FeeVaultFacet | `0x898e2472552421f461c7E878aEEAc2B93B4Cecb6` | Clanker-style fee distribution |

## Research Papers

| # | Title | Author | Key Result |
|---|-------|--------|------------|
| 00 | Core Hypothesis | Ada | Falsifiable hypothesis + methodology |
| 01 | Ethereum Transaction Signing | Ada | Why msg.sender = ecrecover (protocol-level) |
| 02 | Attack Surface Analysis | Ada | 9 vectors enumerated |
| 03 | Diamond Attack Vectors | Vex (Red) | 18 vectors, all blocked |
| 04 | Diamond Defense Audit | Ren (Blue) | 13 findings, 1 CRITICAL |
| 05 | Adversarial AI Framework | Ada | Self-play methodology |
| 06 | Diamond Proxy Security | Ada | EIP-2535 attack surface |
| 07 | Round 2 Attack Report | Vex (Red) | 9 findings, cross-facet focus |
| 08 | Round 2 Defense Audit | Ren (Blue) | 16 findings, 3 CRITICAL |
| 09 | Findings Verification | Ren (Verify) | Honest assessment: 2 MIXED, 2 KNOWN, 4 OUR_FAULT |

## Architecture

```
Diamond Proxy (0x0D5d...B174)
  |
  |-- fallback() --> delegatecall to facet by selector
  |-- receive()  --> treasury ETH accounting
  |
  +-- DiamondCutFacet: diamondCut, transferOwnership, owner
  +-- ChallengeFacet: setFeeRecipient, setMessage, claimSpoof, operators, treasury
  +-- ERC20Facet: full ERC-20 (SPOOF token, 1B supply)
  +-- BountyFacet: submitExploit, approveBounty (1M SPOOF bounty pool)
  +-- FeeVaultFacet: depositFees, claimFees, timelocked fee recipient change
```

## Adversarial Round History

**Round 1**: Attacker tested 18 vectors (spoofing, delegatecall, storage collision, selector clashing, CREATE2, reentrancy, ERC-2771). All blocked. Defender found 13 bugs including missing extcodesize and unprotected critical selectors. **Winner: Defender.**

**Round 2**: Both teams read each other's Round 1 work. Attacker found timelock bypass and TOCTOU race. Defender found claimFees reentrancy and dual ETH accounting. Verification agent confirmed most findings are self-inflicted, not production-grade. **Winner: Defender (but findings are mostly our own weak code).**

## Honest Assessment

We set out to find novel on-chain exploits. We didn't find any zero-days. What we proved:
1. `msg.sender` spoofing is cryptographically impossible without the private key
2. Adversarial self-play DOES find bugs that individual agents miss (cross-facet interactions)
3. The Diamond proxy standard (EIP-2535) has under-protected areas (selector removal, facet code validation)
4. Most of our "critical" findings were self-inflicted design flaws, not production vulnerabilities

The methodology is the contribution, not the bugs.

## License

MIT
