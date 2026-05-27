# 16 — Clanker V4 Fee Mechanism: Complete Flow

## Architecture

```
Token Deployed via Factory
    |
    v
Uniswap V4 Pool (with Hook)
    |  (trades happen, fees accrue)
    v
Hook (ClankerHookDynamicFeeV2) — collects V4 LP fees
    |  (calls storeFees on locker)
    v
Per-Token Locker (e.g. 0x63D2...3496) — stores fees per position
    |  (admin can update recipient)
    v
Global Fee Locker (0xF362...5D68) — aggregated fee storage
    |  (claim() sends to feeOwner)
    v
Fee Recipient wallet
```

## Key Contracts (for "burnout" token)

| Contract | Address | Role |
|----------|---------|------|
| Token | 0xE0A048281bF0dA1A24F360e6a3129959FdAA8b07 | ERC-20 + admin management |
| Hook | 0xDd5EeaFf7BD481AD55Db083062b13a3cdf0A68CC | V4 fee collection + dynamic fees |
| Per-Token Locker | 0x63D2DfEA64b3433F4071A98665bcD7Ca14d93496 | Position mgmt + reward routing |
| Global Fee Locker | 0xF3622742b1E446D92e45E22923Ef11C2fcD55D68 | Fee storage + claims |
| Factory | 0xE85A59c628F7d27878ACeB4bf3b35733630083a9 | Deployment orchestration |

## Fee Recipient Change Mechanism

The per-token locker has 3 admin functions:
- `updateRewardRecipient(token, rewardIndex, newRecipient)` — changes who gets fees
- `updateRewardAdmin(token, rewardIndex, newAdmin)` — changes who can manage
- `updateFeePreference(token, rewardIndex, newFeePreference)` — changes fee split

### Access Control (verified via eth_call simulation)

| Caller | updateRewardRecipient | updateRewardAdmin |
|--------|----------------------|-------------------|
| Current admin (0x7a3E) | SUCCESS | REVERTED (may need additional auth) |
| Random address | REVERTED | REVERTED |

The admin CAN change the reward recipient. Random addresses CANNOT.

## Token Admin Management

The ClankerToken contract has:
- `admin()` — returns current admin
- `originalAdmin()` — returns original deployer
- `updateAdmin(address)` — changes admin (requires msg.sender == current admin)

Changing admin on the TOKEN changes who can manage the locker positions.

## Per-Token Reward Structure

Each token has multiple liquidity positions (up to MAX_LP_POSITIONS), each with:
- `admin` — who can change settings for this position
- `recipient` — who receives fees from this position
- `bps` — basis points of total fees this position gets

## Attack Surface Assessment

1. **Direct access control bypass**: BLOCKED. msg.sender must == admin.
2. **EIP-7702 delegation phishing**: Admin signs a delegation to malicious contract → contract calls updateRewardRecipient. REAL but requires social engineering.
3. **Cross-contract confusion**: The locker checks the ADMIN stored in its own storage, not the token's admin(). If these get out of sync, there could be a window.
4. **updateAdmin on token + updateRewardAdmin on locker**: Two separate admin concepts. Token admin ≠ locker reward admin potentially.

## Value at Stake

- Global fee locker: 432 WETH ($1.08M) + 773 USDC + thousands of other tokens
- Per-token: varies. Active tokens accumulate continuous trading fees.
- "burnout" token: freshly deployed, minimal fees accumulated so far.
