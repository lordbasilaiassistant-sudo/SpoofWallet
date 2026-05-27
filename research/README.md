# SpoofWallet Research Index

## Project

Can browser-level wallet address spoofing bypass on-chain `msg.sender` access controls? And does architectural complexity (Diamond proxy, delegatecall, shared storage) introduce ways to circumvent those controls without breaking the underlying cryptography?

**Core claim under test**: A Chrome extension that overrides `window.ethereum.request({method: 'eth_accounts'})` can fool dApps into displaying a different address, but CANNOT alter `msg.sender` in on-chain transactions because `msg.sender` is derived from the ECDSA signature, not from any client-supplied field. The Diamond proxy extends the attack surface from simple `msg.sender` bypass to delegatecall context manipulation, storage slot collision, and facet replacement vectors.

## Deployed Test Infrastructure

| Contract | Address | Network | Owner | Purpose |
|---|---|---|---|---|
| SpoofTest | `0x7b2e8eE2b88D3Ff8dfB792a8fE4c9CbfD7cc3F4E` | Base mainnet (8453) | `0x7a3E...2334` | Simple onlyOwner baseline |
| SpoofChallenge | `0x2c7985Ff87A7FC85f56030226AeA589F3F86BA6b` | Base mainnet (8453) | `0x7a3E...2334` | Enhanced onlyOwner with multiple guarded functions |
| Diamond | `0x0D5d767Dfad78a81237bCa60d986d68bffE9B174` | Base mainnet (8453) | `0x7a3E...2334` | EIP-2535 Diamond proxy -- primary adversarial target |

## Research Papers

| # | Title | Status | Key Finding |
|---|---|---|---|
| 00 | [Hypothesis](00-hypothesis.md) | Complete | Falsifiable hypothesis, methodology, and predicted outcomes |
| 01 | [Ethereum Transaction Signing](01-ethereum-transaction-signing.md) | Complete | Protocol-level analysis of why `msg.sender` = `ecrecover(txHash, v, r, s)` and what that implies |
| 02 | [Attack Surface Analysis](02-attack-surface-analysis.md) | Complete | Comprehensive enumeration of all 9 spoofing vectors (A1-C3), from trivial to exotic |
| -- | [Exploit Analysis (Red Team)](exploit-analysis.md) | Complete | Vex's red team report testing 8 vectors against live SpoofChallenge contract. All on-chain vectors fail. |
| 05 | [Adversarial AI Security Framework](05-adversarial-framework.md) | Complete | Self-play methodology for smart contract auditing: attacker/defender/documenter agent architecture, comparison to traditional audits, and scaling path from 1v1 to 10v10 tournaments |
| 06 | [Diamond Proxy Security](06-diamond-proxy-security.md) | Complete | EIP-2535 Diamond-specific attack surface: delegatecall context, storage collision, facet replacement, selector grinding, cross-facet reentrancy. Five specific findings for SpoofWallet Diamond. |

## Adversarial Episodes

Episode tracking for the attacker-vs-defender self-play framework.

| Location | Description |
|---|---|
| [episodes/](episodes/) | Episode directory -- see [episodes/README.md](episodes/README.md) for format specification |

Episodes record each attacker vector attempt, the defender's response, the outcome (ATTACKER_WIN / DEFENDER_WIN / DRAW), and the key insight learned. See paper 05 for the full framework description.

## Contract Architecture

```
SpoofTest (simple)           SpoofChallenge (enhanced)         Diamond (EIP-2535)
  |                            |                                  |
  +-- owner (slot 0)          +-- owner (slot 0)                +-- fallback() -> delegatecall
  +-- callPublic()            +-- callPublic()                  |
  +-- callOwnerOnly()         +-- setMessage()                  +-- DiamondStorage (library)
                              +-- setFeeRecipient()             |     +-- contractOwner
                              +-- claimSpoof()                  |     +-- feeRecipient
                              +-- transferOwnership()           |     +-- selector mapping
                              +-- checkCallerVsOwner()          |     +-- operators
                                                                |     +-- treasuryBalance
                                                                |
                                                                +-- DiamondCutFacet
                                                                |     +-- diamondCut()
                                                                |     +-- transferOwnership()
                                                                |     +-- owner()
                                                                |
                                                                +-- ChallengeFacet
                                                                      +-- callPublic()
                                                                      +-- setMessage()
                                                                      +-- setFeeRecipient()
                                                                      +-- claimSpoof()
                                                                      +-- approveOperator()
                                                                      +-- withdrawTreasury()
                                                                      +-- getState()
                                                                      +-- isOperator()
```

## Conventions

- Every claim cites an EIP number, Yellow Paper section, or on-chain evidence (tx hash / contract address).
- Hypotheses are marked **HYPOTHESIS** until tested.
- Negative results are documented with the same rigor as positive results.
- Code examples are minimal and runnable where possible.
- Episodes follow the format specified in [episodes/README.md](episodes/README.md).

## Reproduction

All deployed contracts can be verified on [Basescan](https://basescan.org):
- SpoofTest: https://basescan.org/address/0x7b2e8eE2b88D3Ff8dfB792a8fE4c9CbfD7cc3F4E
- SpoofChallenge: https://basescan.org/address/0x2c7985Ff87A7FC85f56030226AeA589F3F86BA6b
- Diamond: https://basescan.org/address/0x0D5d767Dfad78a81237bCa60d986d68bffE9B174
