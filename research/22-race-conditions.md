# Clanker V4 Race Conditions & Timing Attack Analysis

**Date**: 2026-05-27
**Analyst**: Vex (Red Team, THRYX)
**Scope**: Cross-contract timing attacks across Clanker V4's 5-contract system
**Contracts**:
- Token: `0xE0A048281bF0dA1A24F360e6a3129959FdAA8b07` (ClankerToken)
- Hook: `0xDd5EeaFf7BD481AD55Db083062b13a3cdf0A68CC` (ClankerHookStaticFee)
- Locker: `0x63D2DfEA64b3433F4071A98665bcD7Ca14d93496` (ClankerLpLockerFeeConversion)
- FeeLocker: `0xF3622742b1E446D92e45E22923Ef11C2fcD55D68` (ClankerFeeLocker)
- Factory: `0xE85A59c628F7d27878ACeB4bf3b35733630083a9` (Clanker)

---

## Finding 1: Frontrunning collectRewards via updateRewardRecipient

**Severity: HIGH**
**Status: CONFIRMED -- no PoC exploit executed, code path verified**

### Description

`updateRewardRecipient()` takes effect immediately with no timelock, pending period, or automatic fee collection. Since `collectRewards()` is permissionless and reads `rewardRecipients[]` at execution time (not at fee-accumulation time), an attacker who compromises a `rewardAdmin` key can redirect ALL accumulated uncollected LP fees in a single block.

### Vulnerable Code Path

```
ClankerLpLockerFeeConversion.sol L666-681:
  function updateRewardRecipient(token, rewardIndex, newRecipient)
    if (msg.sender != tokenRewardInfo.rewardAdmins[rewardIndex]) revert;
    tokenRewardInfo.rewardRecipients[rewardIndex] = newRecipient;
    // NO timelock. NO auto-collect. Immediate.

ClankerLpLockerFeeConversion.sol L452-455 (inside _handleFees):
  feeLocker.storeFees(
    tokenRewardInfo.rewardRecipients[toDistributeIndexes[i]],  // reads NEW value
    address(rewardToken),
    tokenToDistribute
  );

ClankerFeeLocker.sol L43-54:
  function claim(feeOwner, token) external   // PERMISSIONLESS
    SafeERC20.safeTransfer(token, feeOwner, balance);
```

### Attack Flow

1. Attacker compromises `rewardAdmin[i]` private key
2. Attacker submits 3 transactions in same block:
   - `locker.updateRewardRecipient(token, i, attackerAddr)`
   - `locker.collectRewards(token)` -- collects all V4 LP fees, stores under attacker
   - `feeLocker.claim(attackerAddr, feeToken)` -- withdraws to attacker EOA
3. All accumulated fees for that reward slot are stolen

### On-Chain Verification

Tested against token `0xE0A0...8b07` (burnout):
- Locker reward slot 0: admin=`0x7a3E...2334`, recipient=`0x7a3E...2334`, 100% BPS
- No timelock mechanism found in contract code
- `collectRewards(token)` callable by any address
- `claim(feeOwner, token)` callable by any address, sends to feeOwner

### Recommended Fix

1. **Auto-collect before redirect**: Call `_collectRewards(token, false)` inside `updateRewardRecipient()` before changing the recipient. This ensures accumulated fees go to the OLD recipient.
2. **Timelock**: Add a 24-48h pending period for recipient changes with a `cancelPendingRecipient()` function.
3. **Monitoring**: Emit events for `updateRewardRecipient` (already done) and set up off-chain monitoring.

### PoC Script
`scripts/clanker-exploits/race/01-frontrun-collect-redirect.js`
`scripts/clanker-exploits/race/07-collect-frontrun-onchain-sim.js`

---

## Finding 2: Cross-Contract Admin State Desync

**Severity: MEDIUM**
**Status: CONFIRMED -- verified on-chain**

### Description

Three independent "admin" concepts exist across the system with no synchronization:

| Admin Store | Location | Changed By | Controls |
|---|---|---|---|
| `ClankerToken._admin` | Token contract | `updateAdmin()` | Metadata, image, verification |
| `Locker.rewardAdmins[i]` | Locker contract | `updateRewardAdmin()` | Fee recipients, fee preferences |
| `Factory.admins[addr]` | Factory contract | `setAdmin()` | Factory operations, team fee claims |

These are set to the SAME address at deploy time but diverge independently afterward. Changing one does NOT change the others.

### Attack Scenario

1. Token deployed with admin = Alice (`_admin`, `rewardAdmins[0]`)
2. Alice calls `token.updateAdmin(Bob)` -- Bob now controls token metadata
3. `locker.rewardAdmins[0]` is STILL Alice
4. Alice retains full fee control despite "transferring" the token
5. Alice redirects Bob's fees: `locker.updateRewardRecipient(token, 0, attacker)`
6. Bob has no way to stop this because locker checks `rewardAdmins`, not `token.admin()`

### On-Chain Verification

Token `0xE0A0...8b07`:
- `token.admin()` = `0x7a3E...2334`
- `locker.rewardAdmins[0]` = `0x7a3E...2334`
- Currently synced, but either can change independently at any time

### Recommended Fix

1. Document clearly that token admin and fee admin are separate roles
2. Consider an atomic `transferFullControl(token, newAdmin)` function
3. UI warning when `token.admin() != locker.rewardAdmins[0]`
4. Or: Make locker read `token.admin()` dynamically (gas cost trade-off)

### PoC Script
`scripts/clanker-exploits/race/02-cross-contract-admin-desync.js`

---

## Finding 3: Fee Locker Already-Stored Fees Are Safe (Defense Confirmation)

**Severity: INFORMATIONAL**
**Status: CONFIRMED -- design is correct**

### Description

The ClankerFeeLocker stores fees keyed by `feeOwner` address. Once `storeFees(A, token, amount)` is called, those fees belong to A regardless of any subsequent changes to the locker's `rewardRecipients[]`.

`claim(feeOwner, token)` is permissionless but ALWAYS sends to `feeOwner`, not `msg.sender`. This means:
- An attacker cannot steal already-stored fees by calling `claim()`
- Already-stored fees survive recipient changes
- The vulnerability window is ONLY between recipient change and the next `collectRewards()` call

### Nuance

`claim()` being permissionless has a minor griefing vector:
- Anyone can force a claim on behalf of a feeOwner
- If feeOwner is a contract that cannot receive tokens (e.g., a reverted receive), fees could be stuck
- An attacker could force-claim to disrupt batched claim strategies

This is minor and the permissionless design is correct for the primary use case.

### PoC Script
`scripts/clanker-exploits/race/03-fee-locker-claim-race.js`

---

## Finding 4: Locker Migration Does Not Affect Existing Pools

**Severity: LOW (design limitation)**
**Status: CONFIRMED -- by-design behavior**

### Description

`Factory.setLocker()` controls which lockers can be used for NEW pool deployments. It does NOT affect existing pools. The hook's `locker[poolId]` mapping is set once during `initializePool()` and never updated.

If a vulnerability is found in an active locker:
- `setLocker(oldLocker, hook, false)` prevents new pools from using it
- Existing pools continue calling `oldLocker.collectRewardsWithoutUnlock()` on every swap
- LP position NFTs are permanently held by the old locker
- No migration path exists for moving positions to a new locker

The locker owner's `withdrawERC20()` can rescue loose ERC20 tokens but cannot transfer V4 position NFTs (no such function exists).

### Recommended Fix

1. Add an emergency migration function with multi-sig + timelock
2. Or: Allow hook owner to update `locker[poolId]` via governance
3. Document that `setLocker()` only affects future pools

### PoC Script
`scripts/clanker-exploits/race/04-locker-migration-orphaned-fees.js`

---

## Finding 5: Permit + Admin Change -- No Novel Attack Surface

**Severity: N/A (non-issue)**
**Status: ANALYZED -- no vulnerability**

### Description

ClankerToken's ERC20Permit grants token transfer approvals only. `updateAdmin()` checks `msg.sender == _admin`, not any permit/approval. There is no way to use a permit to gain admin access.

EIP-7702 delegation requires the admin's own private key signature, adding no attack surface beyond what direct key compromise already provides.

Same-block multi-tx attack (change admin, act, change back) is theoretically possible but:
- Requires the admin's private key
- Leaves an on-chain event trail
- Adds no capability beyond direct key compromise

### PoC Script
`scripts/clanker-exploits/race/05-permit-admin-batch.js`

---

## Finding 6: Hook Fee Collection Race -- Premise Invalid

**Severity: N/A (non-issue)**
**Status: ANALYZED -- the described race does not exist**

### Description

The question asked: "If the locker reads admin from the TOKEN to verify updateRewardRecipient, but the HOOK reads admin from its OWN storage to determine where fees go -- what happens?"

Neither contract reads `token.admin()` for fee routing:

**Protocol fees** (hook path): Hook mints fees to itself via `poolManager.mint()`, then in `_hookFeeClaim()` sends ALL fees to the factory address via `poolManager.take(feeCurrency, factory, fee)`. Factory's `claimTeamFees()` sends to `teamFeeRecipient` (factory-owner-controlled). Token admin is never consulted.

**LP fees** (locker path): Hook calls `locker.collectRewardsWithoutUnlock(token)`. Locker reads its own `_tokenRewards[token].rewardRecipients[]` and distributes via `feeLocker.storeFees()`. Token admin is never consulted.

The actual race condition is between `updateRewardRecipient` and `collectRewards` within the locker itself (Finding 1).

### PoC Script
`scripts/clanker-exploits/race/06-hook-fee-collection-race.js`

---

## Summary Table

| # | Finding | Severity | Exploitable? | Fix Urgency |
|---|---|---|---|---|
| 1 | Frontrun collectRewards via recipient redirect | HIGH | Yes, with compromised rewardAdmin key | Within 48h |
| 2 | Cross-contract admin desync (token vs locker vs factory) | MEDIUM | Yes, after admin "transfer" | Within 1 week |
| 3 | Fee locker stored fees survive recipient change | INFO | N/A (defense property) | None |
| 4 | Locker migration does not affect existing pools | LOW | No (design limitation) | Document |
| 5 | Permit + admin batch -- no novel surface | N/A | No | None |
| 6 | Hook fee collection cross-contract race -- invalid | N/A | No | None |

## Key Architectural Observation

The Clanker V4 system has a clean separation of concerns but a subtle auth model confusion. The word "admin" means three different things in three different contracts, and users/integrators may not understand that transferring token admin does NOT transfer fee control. The highest-impact improvement would be either (a) auto-collecting fees before any recipient change, or (b) making locker admin changes require the token admin's signature.
