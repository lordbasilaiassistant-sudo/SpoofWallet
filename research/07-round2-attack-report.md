# 07 -- Round 2 Diamond Attack Report

**Red Team Report** -- Vex, THRYX
**Date:** 2026-05-27
**Round:** 2 (FeeVault, ERC20, Bounty facets)
**Target:** `0x0D5d767Dfad78a81237bCa60d986d68bffE9B174` (Diamond proxy, Base mainnet, chain 8453)
**Owner:** `0x7a3E312Ec6e20a9F62fE2405938EB9060312E334`
**FeeVaultFacet:** `0x898e2472552421f461c7E878aEEAc2B93B4Cecb6`
**ERC20Facet:** `0xA9ff28e46e2e7CB45369152784413934e1E527f3`
**BountyFacet:** `0x89D55CB0d9b62028f37E6bd0294ce263ee4e73e6`

---

## TL;DR

Round 2 identified **9 findings** (0 CRITICAL, 2 HIGH, 3 MEDIUM, 4 LOW) across the three new facets. The HIGH findings are both related to the same root cause: the FeeVaultFacet's timelock on feeRecipient changes is completely bypassable because two other functions (setFeeRecipientDirect and ChallengeFacet.setFeeRecipient) modify the same storage field without any timelock.

This is a significant upgrade over Round 1 (which found only LOWs and INFOs). The new facets introduce real token balances (10K SPOOF in the fee vault, 1M SPOOF bounty pool) and real economic logic (fee distribution, timelocks), which creates real attack surface.

**The defender found 13 bugs in Round 1. I found 9 NEW bugs in Round 2. We are now even.**

---

## What Changed Since Round 1

Round 1 tested the Diamond with only DiamondCutFacet and ChallengeFacet. The security boundary was purely cryptographic -- every attack path reduced to "do you have the owner's private key?"

Round 2 adds:
1. **FeeVaultFacet** -- Clanker-style fee distribution with ETH+token accounting, timelocked fee recipient changes, and LP fee claims
2. **ERC20Facet** -- Full ERC-20 token (SPOOF) with 1B total supply, approve/transferFrom
3. **BountyFacet** -- Permissionless bug bounty submissions with owner-approved payouts

These facets introduce:
- **Real token balances** held by the Diamond (10K SPOOF in fee vault, 1M in bounty pool)
- **Multiple ETH accounting systems** (ds.treasuryBalance + vs.accumulatedETH)
- **Cross-facet state sharing** (ds.feeRecipient written by 3 different functions across 2 facets)
- **External ETH sends** in claimFees() without reentrancy guards
- **Timelocked state transitions** that can be bypassed

---

## Findings

### R2-F01: Timelock on feeRecipient Change Is Completely Bypassable [HIGH]

**Severity:** HIGH
**Category:** Access control inconsistency
**Affected functions:**
- `FeeVaultFacet.requestFeeRecipientChange()` -- timelocked (60 seconds)
- `FeeVaultFacet.setFeeRecipientDirect()` -- NO timelock
- `ChallengeFacet.setFeeRecipient()` -- NO timelock

**Description:**
Three separate functions write to the same storage field (`ds.feeRecipient` at DiamondStorage offset +4), but only one of them enforces a timelock. The timelock in `requestFeeRecipientChange()` is meaningless because the owner can call `setFeeRecipientDirect()` or `ChallengeFacet.setFeeRecipient()` to change the fee recipient immediately, with no waiting period.

All three functions are `onlyOwner`, so this is not directly exploitable by an external attacker. However:
1. A compromised owner key can silently redirect all fee income in a single tx
2. The existence of the timelock creates a FALSE sense of security for users who check for timelocked changes
3. Monitoring systems that watch `requestFeeRecipientChange` events would miss changes via the other two functions

**Proof:**
```
eth_call from=OWNER to=DIAMOND data=setFeeRecipientDirect(attacker) -> SUCCESS
eth_call from=OWNER to=DIAMOND data=setFeeRecipient(attacker)       -> SUCCESS
// Both bypass the 60-second timelock entirely
```

**Repro:** Owner calls `setFeeRecipientDirect(attacker_address)` -- immediate change.

**Recommended fix:**
1. Remove `setFeeRecipientDirect()` and `ChallengeFacet.setFeeRecipient()` from the selector map
2. All feeRecipient changes MUST go through `requestFeeRecipientChange()` + `executeFeeRecipientChange()`
3. Alternatively, add the same timelock to all three functions

---

### R2-F02: Clanker-Style Rug Pull Vector [HIGH]

**Severity:** HIGH
**Category:** Inherited vulnerability / Economic risk
**Affected functions:** All feeRecipient change functions

**Description:**
The FeeVaultFacet is modeled after Clanker's Locker contract for LP fee distribution. Clanker deployments have been rugged by token deployers who silently change the fee recipient after users buy in, redirecting LP trading fees to themselves.

Our FeeVault was designed to mitigate this with a timelock, but the bypass (R2-F01) means the mitigation is ineffective. The Diamond currently has 10,000 SPOOF tokens accumulated in the fee vault, with 8,000 claimable by the feeRecipient. If the feeRecipient is changed to an attacker address, those 8,000 tokens are stolen.

This is the EXACT vulnerability pattern from production Clanker rugs, and our "fix" (the timelock) is broken.

**Impact:** 8,000 SPOOF tokens at immediate risk if owner key is compromised.

**Repro:** Same as R2-F01.

**Recommended fix:**
1. Fix the timelock bypass (R2-F01)
2. Consider making feeRecipient immutable after initialization
3. Add prominent events on ALL feeRecipient changes for monitoring

---

### R2-F03: claimFees() Has No Reentrancy Guard [MEDIUM]

**Severity:** MEDIUM
**Category:** Reentrancy / Defense-in-depth
**Affected function:** `FeeVaultFacet.claimFees()` (line 83-110)

**Description:**
claimFees() sends ETH via `.call{value: ethShare}("")` on line 105 without a reentrancy guard. The function follows CEI (checks-effects-interactions) for its own state variables (accumulatedETH, accumulatedTokens, totalClaimed), which prevents direct double-claim.

However, during the ETH callback, the recipient can re-enter the Diamond and call any function:
- `depositFees()` to add more ETH/tokens mid-claim
- `withdrawTreasury()` (if recipient is also an operator)
- Any future facet function that reads fee vault state

The CEI pattern protects against simple reentrancy on accumulatedETH, but cross-facet reentrancy remains possible. This is a defense-in-depth gap.

**PoC:** `scripts/diamond-exploits/round2/poc-feevault-reentrancy.sol`

**Recommended fix:**
```solidity
// In DiamondStorage.sol, add:
bool reentrancyLock;

// Shared modifier for all facets:
modifier nonReentrant() {
    DiamondStorage.DiamondState storage ds = DiamondStorage.diamondStorage();
    require(!ds.reentrancyLock, "ReentrancyGuard: reentrant call");
    ds.reentrancyLock = true;
    _;
    ds.reentrancyLock = false;
}

// Apply to: claimFees(), withdrawTreasury(), depositFees()
```

---

### R2-F04: TOCTOU Race in feeRecipient Change [MEDIUM]

**Severity:** MEDIUM
**Category:** Race condition / State inconsistency
**Affected functions:**
- `FeeVaultFacet.requestFeeRecipientChange()`
- `FeeVaultFacet.executeFeeRecipientChange()`
- `FeeVaultFacet.setFeeRecipientDirect()`

**Description:**
A time-of-check-time-of-use race condition exists in the timelocked feeRecipient change:

1. Owner calls `requestFeeRecipientChange(addr_A)` -- sets pending = A, time = now
2. Owner calls `setFeeRecipientDirect(addr_B)` -- immediately sets feeRecipient = B
3. After 60 seconds, `executeFeeRecipientChange()` is called
4. Execute checks only the timelock duration -- NOT whether feeRecipient changed since the request
5. Result: feeRecipient is overwritten from B back to A

`executeFeeRecipientChange()` does not verify that the current feeRecipient matches the one that was active when the request was made. The stale pending change can overwrite a legitimate direct change.

**Repro:**
```
T=0:   requestFeeRecipientChange(A)     -> pending = A
T=10:  setFeeRecipientDirect(B)          -> feeRecipient = B
T=61:  executeFeeRecipientChange()        -> feeRecipient = A (overwrites B!)
```

**Recommended fix:**
- In `setFeeRecipientDirect()` and `ChallengeFacet.setFeeRecipient()`: clear `vs.pendingFeeRecipient` and `vs.feeRecipientChangeRequestTime` to invalidate any pending timelock change
- Or (better): remove the non-timelocked paths entirely (fixes both R2-F01 and R2-F04)

---

### R2-F05: FeeVault Residual ETH Is Permanently Locked [MEDIUM]

**Severity:** MEDIUM
**Category:** Locked funds / Missing withdrawal path
**Affected function:** `FeeVaultFacet.claimFees()` (line 87-88)

**Description:**
When ETH is deposited via `depositFees()`, `vs.accumulatedETH` is incremented. `claimFees()` sends:
```solidity
uint256 ethShare = (vs.accumulatedETH * vs.lpFeesCut) / 10000;
```
With `lpFeesCut = 8000` (80%), only 80% of accumulatedETH is sent to the feeRecipient. The remaining 20% stays in `vs.accumulatedETH` and is NEVER claimable by anyone. There is no function to withdraw the residual.

After each claim, `vs.accumulatedETH -= ethShare` leaves 20% behind. Over time, this residual grows. For every 1 ETH deposited, 0.2 ETH is permanently locked in the Diamond.

**Impact:** 20% of all future ETH fee deposits are permanently locked.

**Repro:** Deposit 1 ETH via `depositFees()`, then call `claimFees()`. Observe 0.2 ETH remains in accumulatedETH with no extraction path.

**Recommended fix:**
Add a function for the owner to withdraw the residual:
```solidity
function withdrawResidual(address to) external onlyOwner {
    FeeVaultStorage.VaultState storage vs = FeeVaultStorage.vaultStorage();
    uint256 residual = vs.accumulatedETH; // Everything that wasn't claimed
    vs.accumulatedETH = 0;
    (bool ok,) = payable(to).call{value: residual}("");
    require(ok, "Transfer failed");
}
```
Or: automatically send the residual to the treasury on each claim.

---

### R2-F06: submitExploit() Permissionless Spam [LOW]

**Severity:** LOW
**Category:** Griefing / Resource exhaustion
**Affected function:** `BountyFacet.submitExploit()`

**Description:**
`submitExploit()` has no access control, no rate limiting, and no deposit requirement. Any address can submit unlimited exploit reports, growing the `exploitIds` array unboundedly. This cluters the owner's review queue and wastes storage.

**Repro:** Call `submitExploit("spam", 4)` repeatedly from any address.

**Recommended fix:** Require a small token deposit (refunded on approval) to submit exploits.

---

### R2-F07: Force-Sent ETH Affects Two Accounting Systems [LOW]

**Severity:** LOW
**Category:** Locked funds (extends Round 1 finding)
**Affected:** Diamond balance vs ds.treasuryBalance vs vs.accumulatedETH

**Description:**
The Diamond now has TWO ETH accounting systems. Force-sent ETH bypasses both. Neither system has a sweep function. The Round 1 recommendation (add sweepETH) was not implemented, and the new FeeVault adds a second tracking system without its own sweep.

Total tracked ETH = ds.treasuryBalance + vs.accumulatedETH.
Actual ETH = address(this).balance.
Any discrepancy is permanently locked.

**Recommended fix:** Add `sweepExcessETH()` that recovers `address(this).balance - totalTracked`.

---

### R2-F08: Tokens Sent Directly to Diamond Are Locked [LOW]

**Severity:** LOW
**Category:** Locked tokens
**Affected function:** `ERC20Facet.transfer()`, `ERC20Facet.transferFrom()`

**Description:**
`transfer(DIAMOND_ADDRESS, amount)` succeeds but the tokens are not tracked by `vs.accumulatedTokens` or `bs.totalBountyPool`. They become phantom balance locked in the Diamond. This parallels the force-sent-ETH issue but for the internal ERC-20.

**Recommended fix:** Add `require(to != address(this), "Cannot transfer to Diamond")` or add a token sweep function.

---

### R2-F09: feeRate Is Dead Code [LOW]

**Severity:** LOW
**Category:** Dead code / Storage waste
**Affected:** `FeeVaultStorage.feeRate`, `FeeVaultFacet.updateFeeRate()`

**Description:**
`vs.feeRate` is set in `initializeVault()` and updateable via `updateFeeRate()`, but no function ever reads it to compute fees. `depositFees()` does not apply any fee percentage. `claimFees()` uses `lpFeesCut`, not `feeRate`. This is dead code.

**Recommended fix:** Either implement feeRate logic in depositFees() or remove the field and updateFeeRate().

---

## Vectors Tested and BLOCKED (No Finding)

| Vector | Result | Why Blocked |
|--------|--------|-------------|
| Token approval exploit (trick Diamond into approving attacker) | BLOCKED | All facets use msg.sender = external caller. No internal self-calls. Cannot make Diamond approve tokens to attacker. |
| Bounty self-approval (submit + approve own exploit) | BLOCKED | approveBounty() is onlyOwner. Cannot approve without owner key. |
| Cross-namespace storage collision | BLOCKED | All four namespaces are keccak256 outputs separated by 76+ digits. Collision is cryptographically infeasible. |
| Initialization replay (re-initialize after deployment) | BLOCKED | All three init functions have `require(!initialized)` guards. |
| Operator drains fee vault ETH | BLOCKED | withdrawTreasury() only sends up to ds.treasuryBalance. Fee vault ETH tracked separately in vs.accumulatedETH. Independent accounting prevents cross-drain. |
| ERC-20 integer overflow | BLOCKED | Solidity 0.8+ built-in overflow checks. |

---

## Comparison With Round 1

| Metric | Round 1 | Round 2 |
|--------|---------|---------|
| Facets tested | 2 (DiamondCut, Challenge) | 3 (FeeVault, ERC20, Bounty) |
| Total findings | 5 | 9 |
| CRITICAL | 0 | 0 |
| HIGH | 0 | 2 |
| MEDIUM | 0 | 3 |
| LOW | 3 | 4 |
| INFO | 2 | 0 |
| Vectors tested | 18 | 13 |
| Attacker wins (episodes) | 0 | 3 |
| Defender wins (episodes) | 15+ | 4 |
| Draws | 3 | 5 |

**Key shift:** Round 1 was purely cryptographic boundary -- every path led to "need owner key." Round 2 introduced DESIGN flaws (inconsistent security policies, locked funds, dead code) that don't require key compromise to be harmful. The timelock bypass is the most significant finding because it defeats a security control that was specifically designed to prevent a known real-world attack pattern (Clanker rugs).

---

## Priority Recommendations for Ren (Defender)

### Must Fix (This Week)
1. **Remove all non-timelocked feeRecipient change functions** (R2-F01, R2-F02) -- the bypass completely defeats the timelock
2. **Add shared reentrancy guard in DiamondStorage** (R2-F03) -- apply to claimFees(), withdrawTreasury(), depositFees()

### Should Fix (This Sprint)
3. **Add residual ETH withdrawal path** (R2-F05) -- 20% of fee deposits are permanently locked
4. **Clear pending timelock on direct changes** (R2-F04) -- prevents TOCTOU race

### Nice To Have
5. **Add token sweep function** (R2-F08)
6. **Add ETH sweep function** (R2-F07)
7. **Rate-limit or deposit-gate submitExploit()** (R2-F06)
8. **Remove or implement feeRate** (R2-F09)

---

## PoC Scripts

| Script | Purpose | Status |
|--------|---------|--------|
| `scripts/diamond-exploits/round2/round2-attack-suite.js` | Automated test of all Round 2 vectors | 9 findings confirmed |
| `scripts/diamond-exploits/round2/poc-feevault-reentrancy.sol` | Reentrancy attacker contract for claimFees() | Design only (requires feeRecipient status) |
| `scripts/diamond-exploits/round2/poc-timelock-bypass.sol` | Timelock bypass demonstration | Documented (owner txs only) |

---

*Vex -- Red Team, THRYX*
*Round 2 completed 2026-05-27*
