# Responsible Disclosure — Clanker V4 Security Findings

**To:** Clanker team (clanker.world)
**From:** SpoofWallet Adversarial AI Security Lab
**Date:** 2026-05-27
**Severity:** 1 MEDIUM-HIGH, 1 MEDIUM, 1 HIGH (design)
**Status:** Pre-disclosure — 90 day window before public release

---

## Finding 1: Zero Slippage on Internal Fee Conversion Swap (MEDIUM-HIGH)

**Location:** ClankerLpLockerFeeConversion._uniSwapUnlocked()
**Impact:** MEV bots can sandwich every fee conversion, extracting value from fee recipients on every Clanker V4 swap.

**Description:**
When `collectRewardsWithoutUnlock` is triggered (on every swap via `_beforeSwap → _lpLockerFeeClaim`), the locker performs an internal swap to convert fees. This swap uses `sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1` (or MAX), which means **zero slippage protection**.

An MEV bot can:
1. Frontrun: manipulate price in the direction that hurts the locker's swap
2. Any user swap triggers fee collection + locker's zero-slippage swap
3. Backrun: profit from the spread

**Proof:** Verified from source code. The `_uniSwapUnlocked` function has no `amountOutMinimum` check. Every pool with accumulated fees and a fee recipient using `FeeIn.Paired` or `FeeIn.Clanker` is affected.

**Recommended Fix:** Add a TWAP-based slippage check or minimum output amount to `_uniSwapUnlocked`. Alternatively, batch fee conversions into a separate function that can be called with proper slippage parameters.

---

## Finding 2: protocolFee Reentrancy Corruption (MEDIUM)

**Location:** ClankerHookStaticFee._beforeSwap() → _lpLockerFeeClaim() → locker swap → hook._beforeSwap() (reentrant)
**Impact:** On asymmetric-fee pools, the `protocolFee` global variable gets corrupted, causing users to be overcharged or the protocol to lose fees.

**Description:**
`protocolFee` is a single `uint24` storage variable shared across ALL pools. When `_lpLockerFeeClaim` triggers a locker swap on the same pool, `_beforeSwap` is called reentrantly, overwriting `protocolFee`. The original swap then reads the wrong fee.

On a pool with `clankerFee=10%, pairedFee=30%`:
- Buying clanker: correct fee 6%, but gets overwritten to 2% → protocol loses 67%
- Selling clanker: correct fee 2%, but gets overwritten to 6% → user overcharged 3x

**Current impact:** Minimal — 775/779 pools have symmetric fees. 4 pools have trivial asymmetry.

**Recommended Fix:** Replace global `protocolFee` with per-pool mapping or pass as local variable.

---

## Finding 3: No Pre-Collection on Reward Recipient Change (HIGH — Design)

**Location:** ClankerLpLockerFeeConversion.updateRewardRecipient()
**Impact:** Compromised admin key can redirect ALL accumulated uncollected fees in one block.

**Description:**
`updateRewardRecipient` changes the fee recipient **immediately** with no timelock, no pending period, and critically **no automatic fee collection before the change**. Since `collectRewards` is permissionless, the attack chain is:

1. `updateRewardRecipient(token, 0, attackerAddr)` — instant
2. `collectRewards(token)` — permissionless, anyone can call
3. `claim(attackerAddr, feeToken)` — permissionless

All accumulated uncollected fees go to the attacker. One block, three calls.

**Proof:** Verified via eth_call simulation against live contracts:
- `updateRewardRecipient` from admin: SUCCESS (instant)
- `updateRewardRecipient` from random: REVERTED (access control holds)
- `collectRewards` from random: SUCCESS (permissionless)
- CREAO token (0x59D9...5D07) has 0.398 WETH unclaimed at time of testing

**Recommended Fix:** Auto-call `_collectRewards(token, false)` inside `updateRewardRecipient` before changing the recipient. This ensures accumulated fees go to the old recipient, and only future fees go to the new one. Alternatively, add a timelock.

---

## Additional Notes

- **Admin desync:** Token.admin(), Locker.rewardAdmins[], and Factory.admins[] are independent. Transferring token admin does NOT change fee control. This is by-design but creates false security assumptions.
- **Shadow pools:** `initializePoolOpen()` allows permissionless pool creation without LP fee collection or MEV protection.
- **Bridge risk:** IERC7802 implementation means all Clanker tokens will be bridge-mintable when SuperchainTokenBridge activates.

## Disclosure Timeline

- **2026-05-27:** Findings documented
- **2026-05-28:** Contact Clanker team (email/Farcaster)
- **2026-08-27:** Public release (90 days)

## Contact

GitHub: github.com/lordbasilaiassistant-sudo/SpoofWallet
Research: lordbasilaiassistant-sudo.github.io/SpoofWallet/
