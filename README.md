# Spoof Wallet — Adversarial AI Security Lab

Live adversarial AI research: attacker agents vs defender agents competing on real smart contracts deployed on Base mainnet. A documenter agent tracks every episode. The goal: find novel on-chain exploits or prove the security boundary is cryptographic.

**Live Dashboard**: [lordbasilaiassistant-sudo.github.io/SpoofWallet](https://lordbasilaiassistant-sudo.github.io/SpoofWallet/)

## What This Is

An autonomous AI security lab where:
- **Attacker agents** try to break smart contract access controls via spoofing, reentrancy, storage corruption, cross-facet exploits, and more
- **Defender agents** audit contracts, find vulnerabilities, and recommend hardening
- **Documenter agents** track every attack/defense round as structured episodes
- **Real contracts on Base mainnet** with real tokens at stake (SPOOF bounty pool)
- **Public scoreboard** showing findings, affected production contracts, and round-by-round results

## Deployed Contracts (Base Mainnet)

| Contract | Address | Purpose |
|----------|---------|---------|
| Diamond Proxy | `0x0D5d767Dfad78a81237bCa60d986d68bffE9B174` | EIP-2535 proxy with delegatecall routing |
| DiamondCutFacet | `0x2523cec75f2eE829f65A3eDAE49E12976f414c07` | Upgrade mechanism, ownership |
| ChallengeFacet | `0x7c6634E064F2b7148b0896EC93dBBe9b7Ee824CE` | Fee recipient, message, spoof flag, operators |
| ERC20Facet | `0xA9ff28e46e2e7CB45369152784413934e1E527f3` | SPOOF token (1B supply) |
| BountyFacet | `0x89D55CB0d9b62028f37E6bd0294ce263ee4e73e6` | Exploit submission + reward system |
| FeeVaultFacet | `0x898e2472552421f461c7E878aEEAc2B93B4Cecb6` | Clanker-style fee distribution |
| SpoofChallenge | `0x2c7985Ff87A7FC85f56030226AeA589F3F86BA6b` | Simple onlyOwner test contract |

## Findings Summary

| Round | Attacker | Defender | Total | Critical |
|-------|----------|----------|-------|----------|
| 1 | 18 vectors tested, 0 exploits, 3 LOW | 13 findings (1C, 2H, 5M) | 16 unique | 1 |
| 2 | In progress | 16 findings (3C, 3H, 5M) | 32+ | 4 |

### Critical Discoveries

1. **diamondCut missing extcodesize** — can permanently brick the Diamond (Round 1)
2. **claimFees reentrancy** — malicious fee recipient can drain ETH vault (Round 2)
3. **Timelock bypass** — setFeeRecipientDirect renders the 2-step timelock pointless (Round 2)
4. **Dual ETH accounting** — treasuryBalance and accumulatedETH both claim same balance, creating insolvency (Round 2)

### Affected Production Contracts

These findings apply to any contract using the same patterns:
- Custom Diamond implementations without extcodesize check
- Clanker-style fee distribution with direct change + timelock options
- Any Diamond with uncapped operator withdrawal authority
- Single-step ownership transfers (OpenZeppelin Ownable, not Ownable2Step)

## Research Papers

| # | Title | Author |
|---|-------|--------|
| 00 | Core Hypothesis | Ada |
| 01 | Ethereum Transaction Signing | Ada |
| 02 | Attack Surface Analysis | Ada |
| 03 | Diamond Attack Vectors | Vex (Red Team) |
| 04 | Diamond Defense Audit | Ren (Blue Team) |
| 05 | Adversarial AI Framework | Ada |
| 06 | Diamond Proxy Security | Ada |
| 07 | Round 2 Attack Report | Vex (in progress) |
| 08 | Round 2 Defense Audit | Ren |

## Token Economics

- **SPOOF Token**: 1B total supply, ERC-20 inside Diamond via delegatecall
- **Bounty Pool**: 1M SPOOF (0.1% of supply) locked for exploit rewards
- **Max per exploit**: 100K SPOOF
- **Fee Vault**: 10K SPOOF deposited as simulated trading fees, 80% claimable by fee recipient

## Architecture

```
Diamond Proxy (0x0D5d...B174)
  |
  |-- fallback() --> delegatecall to facet by selector
  |-- receive()  --> treasury ETH accounting
  |
  +-- DiamondCutFacet: diamondCut, transferOwnership, owner
  +-- ChallengeFacet: setFeeRecipient, setMessage, claimSpoof, operators, treasury
  +-- ERC20Facet: full ERC-20 (name, symbol, transfer, approve, etc.)
  +-- BountyFacet: submitExploit, approveBounty, bounty pool management
  +-- FeeVaultFacet: depositFees, claimFees, fee recipient timelock + direct change
```

## How the Adversarial Lab Works

1. Contracts are deployed with intentionally varied security patterns
2. Attacker agents probe for exploits (spoofing, reentrancy, storage collision, cross-facet)
3. Defender agents audit and find vulnerabilities
4. Documenter tracks rounds as structured episodes
5. Each round, both teams read each other's findings — no repeating proven failures
6. Dashboard updates with new findings, severity ratings, and affected production contracts

## Educational Purpose

This project demonstrates:
- Why `msg.sender` cannot be spoofed (ECDSA signature recovery)
- How Diamond proxy patterns create real attack surface (delegatecall, storage, facets)
- Cross-facet vulnerabilities that single-contract audits miss
- How adversarial self-play finds bugs that individual auditors don't

## License

MIT
