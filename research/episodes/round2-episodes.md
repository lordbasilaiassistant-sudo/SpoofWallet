# Round 2 Adversarial Episodes

**Attacker:** Vex (Red Team)
**Date:** 2026-05-27
**Target:** Diamond `0x0D5d767Dfad78a81237bCa60d986d68bffE9B174` (Base mainnet 8453)
**New facets tested:** FeeVaultFacet, ERC20Facet, BountyFacet

---

## Episode R2-001: FeeVault claimFees() Reentrancy [MEDIUM]

**Target function:** `FeeVaultFacet.claimFees()`
**Attack vector:** Cross-facet reentrancy via ETH callback

### Attacker Vector
claimFees() sends ETH via `.call{value}` on line 105 after updating token balances (line 99-100) but without a reentrancy lock. A malicious feeRecipient contract receives the ETH callback and can re-enter any Diamond function. While accumulatedETH is decremented before the send (CEI on that specific field), no global reentrancy guard prevents cross-facet state manipulation during the callback window.

### Attack Code
```solidity
// poc-feevault-reentrancy.sol
receive() external payable {
    diamond.depositFees{value: msg.value}(0); // re-enter deposit
    try diamond.claimFees() {} catch {}       // attempt double-claim
}
```

### Defender Response
Existing CEI pattern on accumulatedETH prevents direct double-claim. But the lack of a shared reentrancy lock means new facets could be vulnerable to cross-facet reentrancy in the future.

### Outcome
**Result:** DRAW
**State change achieved:** NO (requires feeRecipient status)
**Access control bypassed:** NO
**Funds at risk:** Potential future risk if new facets add state dependencies

### Key Insight
CEI is necessary but not sufficient for Diamond proxies. A shared reentrancy lock in DiamondStorage is needed because any facet's external call can re-enter any other facet.

---

## Episode R2-002: Timelock Bypass via setFeeRecipientDirect [HIGH]

**Target function:** `FeeVaultFacet.setFeeRecipientDirect()`, `ChallengeFacet.setFeeRecipient()`
**Attack vector:** Timelock circumvention -- same state field writable by three functions with different security policies

### Attacker Vector
requestFeeRecipientChange() implements a 60-second timelock, but setFeeRecipientDirect() and ChallengeFacet.setFeeRecipient() both write to the same ds.feeRecipient field IMMEDIATELY with no timelock. The owner (or a compromised owner key) can bypass the timelock entirely. The timelock is security theater.

### Attack Code
```
owner calls: setFeeRecipientDirect(attacker_address)
Result: feeRecipient changed immediately, no waiting, no timelock
```

### Defender Response
N/A -- this is a design flaw in the current code.

### Outcome
**Result:** ATTACKER_WIN (design flaw confirmed)
**State change achieved:** YES (simulated -- owner eth_call succeeds)
**Access control bypassed:** NO (requires owner key)
**Funds at risk:** All future fee income (10K SPOOF accumulated, 8K claimable)

### Evidence Chain

| Item | Value |
|------|-------|
| Attack tx hash | N/A (eth_call simulation) |
| eth_call result | setFeeRecipientDirect from owner: SUCCESS |
| eth_call result | setFeeRecipient from owner: SUCCESS |
| Contract state before | feeRecipient = 0x7a3E312E... (owner) |
| Contract state after | feeRecipient = attacker (simulated) |

### Key Insight
When multiple functions modify the same state field, all must enforce the same security policy. Inconsistent protection on a shared field means the weakest path wins.

---

## Episode R2-003: TOCTOU Race in feeRecipient Change [MEDIUM]

**Target function:** `FeeVaultFacet.executeFeeRecipientChange()`
**Attack vector:** Time-of-check-time-of-use -- stale pending change overwrites direct change

### Attacker Vector
1. Owner calls requestFeeRecipientChange(A) -- sets pendingFeeRecipient = A
2. Owner calls setFeeRecipientDirect(B) -- immediately sets feeRecipient = B
3. After 60 seconds, owner (or attacker who socially engineers it) calls executeFeeRecipientChange()
4. executeFeeRecipientChange() only checks the timelock duration, NOT whether the current feeRecipient has changed since the request. It overwrites B with A.

### Outcome
**Result:** DRAW (owner footgun, not external attack)
**State change achieved:** NO (simulation only)
**Funds at risk:** NONE directly (incorrect recipient, not stolen funds)

### Key Insight
executeFeeRecipientChange() should verify the current feeRecipient matches the one active when the change was requested, or at minimum, setFeeRecipientDirect() should clear the pending change.

---

## Episode R2-004: Token Approval Exploit [BLOCKED]

**Target function:** `ERC20Facet.approve()`, `ERC20Facet.transferFrom()`
**Attack vector:** Trick Diamond into approving attacker for token withdrawals

### Attacker Vector
Attempted to find a path where the Diamond (address(this)) calls approve() with msg.sender = Diamond, which would set ts.allowances[Diamond][attacker]. This would allow calling transferFrom(Diamond, attacker, amount) to steal the Diamond's token holdings (bounty pool + fee deposits).

### Outcome
**Result:** DEFENDER_WIN
**State change achieved:** NO
**Access control bypassed:** NO

### Key Insight
All facet functions execute via delegatecall where msg.sender = external caller, never address(this). No internal self-call mechanism exists. The Diamond cannot approve tokens on behalf of itself unless a malicious facet is added via diamondCut (requires owner key).

---

## Episode R2-005: Bounty Queue Spam [LOW]

**Target function:** `BountyFacet.submitExploit()`
**Attack vector:** Permissionless submission griefing

### Attacker Vector
submitExploit() has no rate limiting, no deposit requirement, and no access control. Any address can submit unlimited exploit reports, growing the exploitIds array unboundedly and cluttering the owner's review queue.

### Outcome
**Result:** DRAW (griefing possible but no fund impact)
**Funds at risk:** NONE

---

## Episode R2-006: Dual ETH Accounting Lockup [LOW]

**Target function:** Diamond receive() + FeeVaultFacet.depositFees()
**Attack vector:** Force-sent ETH bypasses both accounting systems

### Attacker Vector
The Diamond now has TWO ETH accounting systems: ds.treasuryBalance (incremented by receive()) and vs.accumulatedETH (incremented by depositFees()). Force-sent ETH (via selfdestruct) bypasses both. The Round 1 recommendation (add sweepETH) has not been implemented, and the new FeeVault adds a second system without its own sweep.

### Outcome
**Result:** DRAW (griefing -- attacker loses own ETH)
**Funds at risk:** NONE (attacker's own ETH is locked, not stolen)

---

## Episode R2-007: FeeVault Residual ETH Lock [MEDIUM]

**Target function:** `FeeVaultFacet.claimFees()`
**Attack vector:** Permanent lockup of residual ETH (100% - lpFeesCut)

### Attacker Vector
When ETH is deposited via depositFees(), vs.accumulatedETH is incremented. claimFees() sends only (accumulatedETH * lpFeesCut / 10000) to the feeRecipient. With lpFeesCut = 8000 (80%), the remaining 20% stays in vs.accumulatedETH and is NEVER claimable by anyone. There is no function to withdraw the residual. Over time, this accumulates.

### Outcome
**Result:** ATTACKER_WIN (design flaw -- funds permanently locked)
**Funds at risk:** 20% of all future ETH fee deposits

### Key Insight
If lpFeesCut < 10000, there must be a function to withdraw the remainder. Currently, 20% of all ETH deposited via depositFees() is permanently locked in the Diamond.

---

## Episode R2-008: Cross-Namespace Storage Collision [BLOCKED]

**Target:** All four storage namespaces
**Attack vector:** Storage slot overlap between namespaces

### Outcome
**Result:** DEFENDER_WIN
All four namespace bases are keccak256 outputs separated by 76+ decimal digits. Collision is cryptographically infeasible.

---

## Episode R2-009: Initialization Replay [BLOCKED]

**Target functions:** initializeVault(), initializeToken(), initializeBounty()
**Attack vector:** Re-initialization of already-initialized facets

### Outcome
**Result:** DEFENDER_WIN
All three initialize functions have `require(!initialized)` guards that correctly prevent replay.

---

## Episode R2-010: ERC20 Edge Cases [LOW]

**Target function:** `ERC20Facet.transfer()`
**Attack vector:** Transfer tokens directly to Diamond address

### Attacker Vector
transfer(DIAMOND_ADDRESS, amount) succeeds but tokens are not tracked by FeeVaultStorage or BountyStorage. They become phantom balance locked in the Diamond. This parallels the force-sent-ETH issue but for tokens.

### Outcome
**Result:** DRAW (requires attacker to spend their own tokens)
**Funds at risk:** NONE (attacker loses own tokens)

---

## Episode R2-011: Operator + FeeVault Cross-Drain [BLOCKED]

**Target functions:** withdrawTreasury() + claimFees()
**Attack vector:** Operator drains fee vault ETH via treasury withdrawal

### Outcome
**Result:** DEFENDER_WIN
The two accounting systems are independent. withdrawTreasury() is capped by ds.treasuryBalance. claimFees() is capped by vs.accumulatedETH. Neither can drain the other.

---

## Episode R2-012: Dead feeRate Code [LOW]

**Target:** FeeVaultStorage.feeRate
**Attack vector:** N/A -- dead code finding

### Outcome
**Result:** N/A (informational)
feeRate is stored and updateable but read by no function. Dead code.

---

## Episode R2-013: Clanker-Style Rug Pull Vector [HIGH]

**Target function:** feeRecipient change functions
**Attack vector:** Silent fee income redirection (inherited from Clanker pattern)

### Attacker Vector
The FeeVault is modeled after Clanker's Locker contract. Clanker deployments have been rugged by token deployers silently changing the fee recipient. Our FeeVault was designed to mitigate this with a timelock, but the bypass (R2-2) means the mitigation is ineffective. A compromised owner key can redirect all fee income in a single transaction.

### Outcome
**Result:** ATTACKER_WIN (design flaw -- timelock defeated)
**Funds at risk:** 10K SPOOF accumulated in vault (8K claimable by feeRecipient)

---

## Summary

| Episode | Vector | Result | Severity |
|---------|--------|--------|----------|
| R2-001 | FeeVault reentrancy | DRAW | MEDIUM |
| R2-002 | Timelock bypass | ATTACKER_WIN | HIGH |
| R2-003 | TOCTOU race | DRAW | MEDIUM |
| R2-004 | Token approval | DEFENDER_WIN | N/A |
| R2-005 | Bounty spam | DRAW | LOW |
| R2-006 | Dual ETH lockup | DRAW | LOW |
| R2-007 | Residual ETH lock | ATTACKER_WIN | MEDIUM |
| R2-008 | Namespace collision | DEFENDER_WIN | N/A |
| R2-009 | Init replay | DEFENDER_WIN | N/A |
| R2-010 | ERC20 edge cases | DRAW | LOW |
| R2-011 | Operator cross-drain | DEFENDER_WIN | N/A |
| R2-012 | Dead feeRate | N/A | LOW |
| R2-013 | Clanker rug pull | ATTACKER_WIN | HIGH |

**Attacker wins:** 3 (R2-002, R2-007, R2-013)
**Defender wins:** 4 (R2-004, R2-008, R2-009, R2-011)
**Draws:** 5 (R2-001, R2-003, R2-005, R2-006, R2-010)
**Informational:** 1 (R2-012)
