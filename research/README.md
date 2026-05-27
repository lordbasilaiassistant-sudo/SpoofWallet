# SpoofWallet Research Index

## Project

Can browser-level wallet address spoofing bypass on-chain `msg.sender` access controls?

**Core claim under test**: A Chrome extension that overrides `window.ethereum.request({method: 'eth_accounts'})` can fool dApps into displaying a different address, but CANNOT alter `msg.sender` in on-chain transactions because `msg.sender` is derived from the ECDSA signature, not from any client-supplied field.

## Deployed Test Infrastructure

| Contract | Address | Network | Owner |
|---|---|---|---|
| SpoofTest | `0x7b2e8eE2b88D3Ff8dfB792a8fE4c9CbfD7cc3F4E` | Base mainnet (8453) | `0x7a3E...2334` |
| SpoofChallenge | `0xE80ca47D14B56cce3AB0e7A993603CA6d52Bd8A8` | Base mainnet (8453) | `0x7a3E...2334` |

## Research Papers

| # | Title | Status | Key Finding |
|---|---|---|---|
| 00 | [Hypothesis](00-hypothesis.md) | Complete | Falsifiable hypothesis, methodology, and predicted outcomes |
| 01 | [Ethereum Transaction Signing](01-ethereum-transaction-signing.md) | Complete | Protocol-level analysis of why `msg.sender` = `ecrecover(txHash, v, r, s)` and what that implies |
| 02 | [Attack Surface Analysis](02-attack-surface-analysis.md) | Complete | Comprehensive enumeration of all spoofing vectors, from trivial to exotic |
| -- | [Exploit Analysis (Red Team)](exploit-analysis.md) | Complete | Vex's red team report testing 8 vectors against live SpoofChallenge contract. All on-chain vectors fail. |

## Conventions

- Every claim cites an EIP number, Yellow Paper section, or on-chain evidence (tx hash / contract address).
- Hypotheses are marked **HYPOTHESIS** until tested.
- Negative results are documented with the same rigor as positive results.
- Code examples are minimal and runnable where possible.

## Reproduction

All deployed contracts can be verified on [Basescan](https://basescan.org):
- SpoofTest: https://basescan.org/address/0x7b2e8eE2b88D3Ff8dfB792a8fE4c9CbfD7cc3F4E
- SpoofChallenge: https://basescan.org/address/0xE80ca47D14B56cce3AB0e7A993603CA6d52Bd8A8
