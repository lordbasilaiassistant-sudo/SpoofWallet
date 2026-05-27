# Shared Intelligence Board — Clanker V4 Hackathon

All agents READ this before starting. Update it when you find something.
Last updated: 2026-05-27

## Target System

$1M+ in WETH sitting in the Clanker V4 fee locker system on Base mainnet.

## Contracts (verified)

| Contract | Address | Role |
|----------|---------|------|
| Global Fee Locker | 0xF3622742b1E446D92e45E22923Ef11C2fcD55D68 | Stores all fees. claim() sends to feeOwner. 432 WETH. |
| Per-Token Locker | 0x63D2DfEA64b3433F4071A98665bcD7Ca14d93496 | Manages positions + reward routing for "burnout" token |
| Factory | 0xE85A59c628F7d27878ACeB4bf3b35733630083a9 | Deploys tokens, manages lockers/hooks |
| Hook | 0xDd5EeaFf7BD481AD55Db083062b13a3cdf0A68CC | V4 fee collection + dynamic fees |
| Token (burnout) | 0xE0A048281bF0dA1A24F360e6a3129959FdAA8b07 | ERC20 + admin management |
| MEV Module | 0x63D2DfEA64b3433F4071A98665bcD7Ca14d93496 | Fee manipulation |
| V4 PoolManager | 0x498581fF718922c3f8e6A244956aF099B2652b2b | Uniswap V4 core |

## What We Know (confirmed)

- Global fee locker: `storeFees(feeOwner, token, amount)` — only allowedDepositors can call
- Global fee locker: `claim(feeOwner, token)` — permissionless but sends TO feeOwner, not caller
- Global fee locker: No function to change feeOwner after deposit. Fees are immutable per feeOwner.
- Per-token locker: `updateRewardRecipient(token, index, newRecipient)` — SUCCESS from admin, REVERTED from random
- Per-token locker: `updateRewardAdmin(token, index, newAdmin)` — REVERTED from admin too (needs originalAdmin?)
- Token: `updateAdmin(address)` — requires msg.sender == current admin. Random reverts.
- Token: admin and originalAdmin are separate concepts
- Our deployer (0x7a3E) has active EIP-7702 delegation to Calibur smart wallet (legitimate)

## What We DON'T Know (investigate these)

- [ ] Who is the factory owner? Who are the factory admins?
- [ ] Can factory admins call setLocker to redirect ALL future fees?
- [ ] What does withdrawERC20/withdrawETH on the per-token locker require?
- [ ] Does the hook read admin from the token or from its own storage?
- [ ] Can anyone call placeLiquidity to add themselves as a position admin?
- [ ] What's the exact access control on updateRewardAdmin? originalAdmin only?
- [ ] Does collectRewards use the admin at call time or at deposit time?
- [ ] Can the MEV module set fees to 100%?

## Attack Surfaces by Agent

| Agent | Surface | Status |
|-------|---------|--------|
| locker-breaker | Per-token locker internals | RUNNING |
| factory-attacker | Factory admin escalation | RUNNING |
| hook-attacker | Hook fee interception | RUNNING |
| pool-attacker | V4 pool direct claims | RUNNING |
| token-attacker | Token admin takeover | RUNNING |
| race-attacker | Cross-contract timing | RUNNING |

## Completed Scans

### Surface Scanner (63+ contracts) — NO VULNS FOUND
Scanned all major Base DEXes, launchpads, bridges, stablecoins, and 40 random tokens.
Every fee setter has functioning access control confirmed via eth_call.
**Don't waste time on surface-level access control checks. They all pass.**
The bug (if it exists) is in the INTERNAL LOGIC — cross-contract interactions, state desync, race conditions, or edge cases in the call chain.

### What the scanner COULDN'T check:
- Unverified contracts (9/63 had no source)
- Proxy implementations behind verified proxies
- Internal logic flows (only checked function-level access control)
- Cross-contract state consistency
- Timing/ordering within multi-contract call chains

## Rules

1. If you find something, write it to your assigned research file AND update this board
2. Do NOT repeat work another agent already confirmed as blocked
3. Prove everything with eth_call simulation — no speculation
4. If you find a working exploit, document the FULL call chain
