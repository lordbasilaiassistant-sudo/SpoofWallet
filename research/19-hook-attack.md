# 19 -- ClankerHookStaticFee Attack Surface Analysis

**Target:** ClankerHookStaticFee @ `0xDd5EeaFf7BD481AD55Db083062b13a3cdf0A68CC` (Base)
**Contract name on-chain:** ClankerHookStaticFee (verified source, Solidity 0.8.28)
**Date:** 2026-05-27
**Analyst:** Vex (Red Team)

---

## Architecture Summary

```
User Swap
  |
  v
Uniswap V4 PoolManager
  |  (calls hook.beforeSwap / hook.afterSwap)
  v
ClankerHookStaticFee (this contract)
  |-- _setFee: writes global protocolFee, updates dynamic LP fee
  |-- _hookFeeClaim: burns ERC6909 credits, takes tokens to factory
  |-- _lpLockerFeeClaim: triggers locker.collectRewardsWithoutUnlock()
  |-- _runMevModule: calls mevModule.beforeSwap() (first 2 min only)
  |-- fee calculation: uses global protocolFee for delta/mint
  v
Factory (0xE85A...) receives protocol fees
  |
  v
teamFeeRecipient (0xFC535...) receives claimed team fees
```

**Governance:** Gnosis Safe at `0xEea96d959963EaB488A3d4B7d5d347785cf1Eab8` (2-of-8 multisig) owns Factory, Fee Locker, and LP Locker.

**Hook Owner:** `0x4e59b44847b379578588920cA78FbF26c0B4956C` (CREATE2 deterministic deployer -- effectively no owner can call Ownable functions).

---

## Finding 1: protocolFee Global State Corruption via Locker Reentrancy

**Severity:** MEDIUM (code-level bug; minimal current real-world impact)

### Description

`protocolFee` is a single `uint24` state variable (storage slot 0, packed with `owner`) shared across ALL pools managed by this hook. During `_beforeSwap`, the execution flow is:

1. `_setFee()` writes `protocolFee` based on the current swap direction
2. `_hookFeeClaim()` claims accumulated protocol fees (no reentrancy)
3. `_lpLockerFeeClaim()` calls `locker.collectRewardsWithoutUnlock(token)`
4. The locker's `_collectRewards` calls `_handleFees` which may call `_uniSwapUnlocked`
5. `_uniSwapUnlocked` calls `poolManager.swap()` on the **same pool**
6. This triggers `hook._beforeSwap()` **again** (reentrant call)
7. The reentrant `_setFee()` **overwrites** `protocolFee` based on the locker's swap direction
8. When the original `_beforeSwap` resumes at step 5 (fee calculation), it reads the **corrupted** `protocolFee`
9. `_afterSwap` for the original swap also reads the corrupted value

### Preconditions

- Pool has **asymmetric** fees (`clankerFee != pairedFee`)
- At least one fee recipient has `feePreference != FeeIn.Both` (triggers locker swap)
- Pool has accumulated fees in a token that needs conversion

### Impact

On an asymmetric-fee pool (e.g., clankerFee=10%, pairedFee=30%):
- Buying clanker: correct protocolFee = 6%, but locker's sell-clanker swap overwrites it to 2% --> protocol loses 67% of intended fee
- Selling clanker: correct protocolFee = 2%, but locker's buy-clanker swap overwrites it to 6% --> user overcharged by 3x

### Current Real-World Impact

**MINIMAL.** Of 779 pools analyzed:
- 775 have symmetric fees (zero impact even if reentrancy fires)
- 4 have clankerFee=32, pairedFee=0 (trivial values, sub-0.001% difference)

The bug becomes meaningful only if pools with significant fee asymmetry are created.

### Repro

```
scripts/clanker-exploits/hook/poc-protocolfee-reentrancy.js
```

### Recommended Fix

Replace the global `protocolFee` storage variable with either:
- A local variable passed between `_setFee`, `_beforeSwap`, and `_afterSwap`
- A per-pool mapping: `mapping(PoolId => uint24) internal protocolFees`

---

## Finding 2: Hook Owner Set to CREATE2 Deployer (Immutable Dead Owner)

**Severity:** LOW (informational)

### Description

The hook's `owner()` returns `0x4e59b44847b379578588920cA78FbF26c0B4956C`, which is the deterministic deployment proxy (CREATE2 factory). This contract has 69 bytes of code and cannot execute arbitrary calls. The Ownable `transferOwnership()` and `renounceOwnership()` functions are permanently uncallable.

### Impact

Currently benign because the hook has **no onlyOwner functions** beyond the inherited Ownable base. However, if a future upgrade or fork adds owner-gated functionality (e.g., emergency pause, fee override), that functionality would be permanently inaccessible.

### Recommended Fix

Transfer ownership to the governance Safe (`0xEea96d...`) or renounce explicitly during deployment.

---

## Finding 3: initializePoolOpen Allows Permissionless Shadow Pools

**Severity:** LOW

### Description

`initializePoolOpen()` is a public function that lets anyone create a new V4 pool for any token pair using this hook. Pools created via this path have:
- `locker[poolId] = address(0)` (no auto LP fee claim)
- `mevModule[poolId] = address(0)` (no MEV protection)
- No connection to the token's original deployment

### Impact

An attacker could create a competing pool for a popular Clanker token with different tick spacing or initial price. Trades on this shadow pool would:
- Still pay protocol fees to the factory (hook behavior is the same)
- NOT trigger LP fee auto-collection for the token's legitimate LP position holders
- NOT have MEV protection during the first 2 minutes

This is a liquidity fragmentation risk, not a direct theft vector.

### Recommended Fix

Consider adding a check in `initializePoolOpen` to prevent creating pools for tokens that already have a factory-initialized pool, or mark it as intended behavior.

---

## Finding 4: ClankerFeeLocker.claim() is Permissionless (By Design)

**Severity:** INFORMATIONAL

### Description

`ClankerFeeLocker.claim(feeOwner, token)` can be called by anyone. It sends the accumulated fees for `feeOwner` to the `feeOwner` address (not to msg.sender).

### Impact

This is intentional -- it allows bots or UIs to trigger claims on behalf of users. Funds always flow to the correct recipient. No exploit possible.

---

## Vectors Investigated and Found Safe

| Vector | Result |
|--------|--------|
| Redirect protocol fees (change factory) | SAFE: `factory` is immutable |
| MEV module fee manipulation | SAFE: module only returns bool, expires in 2min |
| delegatecall in hook | SAFE: not used anywhere |
| initializePreLockerSetup re-call | SAFE: function does not exist in this contract |
| Malicious token.admin() return | SAFE: hook never calls token.admin() |
| Front-run fee collection with admin change | SAFE: hook/locker use internal storage, not token.admin() |
| storeFees depositor spoofing | SAFE: allowedDepositors whitelist enforced |
| Cross-pool protocolFee contamination | SAFE: each swap sets protocolFee at start of _beforeSwap; multi-hop swaps are sequential |

---

## Key Contract Addresses

| Contract | Address | Owner/Controller |
|----------|---------|-----------------|
| ClankerHookStaticFee | `0xDd5EeaFf7BD481AD55Db083062b13a3cdf0A68CC` | CREATE2 deployer (dead) |
| Factory | `0xE85A59c628F7d27878ACeB4bf3b35733630083a9` | Gnosis Safe |
| Fee Locker | `0xF3622742b1E446D92e45E22923Ef11C2fcD55D68` | Gnosis Safe |
| LP Locker (burnout) | `0x63D2DfEA64b3433F4071A98665bcD7Ca14d93496` | Gnosis Safe |
| Gnosis Safe | `0xEea96d959963EaB488A3d4B7d5d347785cf1Eab8` | 2-of-8 (8 EOA signers) |
| Team Fee Recipient | `0xFC535Ead4104177B70bf235D67Ab436d99788e04` | Gnosis Safe |
| WETH | `0x4200000000000000000000000000000000000006` | -- |
| V4 PoolManager | `0x498581fF718922c3f8e6A244956aF099B2652b2b` | -- |

---

## Pool Fee Distribution (779 pools, last ~3 weeks)

| Fee Config (clanker/paired) | Count | Note |
|-----------------------------|-------|------|
| 150000/150000 (15%/15%) | 392 | Most common |
| 120000/120000 (12%/12%) | 296 | Second most common |
| 10000/10000 (1%/1%) | 46 | Low-fee pools |
| 200000/200000 (20%/20%) | 41 | High-fee pools |
| 32/0 (0.003%/0%) | 4 | Only asymmetric pools |

---

## Scripts

- `scripts/clanker-exploits/hook/poc-protocolfee-reentrancy.js` -- demonstrates the protocolFee corruption bug
- `scripts/clanker-exploits/hook/hook-state-query.js` -- reads full hook/factory/locker state
