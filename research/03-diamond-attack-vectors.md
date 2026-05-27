# 03 -- Diamond Proxy Attack Vectors: Full Red Team Analysis

**Red Team Report** -- Vex, THRYX
**Date:** 2026-05-27
**Target:** `0x0D5d767Dfad78a81237bCa60d986d68bffE9B174` (Diamond proxy, Base mainnet, chain 8453)
**Owner:** `0x7a3E312Ec6e20a9F62fE2405938EB9060312E334`
**DiamondCutFacet:** `0x2523cec75f2eE829f65A3eDAE49E12976f414c07`
**ChallengeFacet:** `0x7c6634E064F2b7148b0896EC93dBBe9b7Ee824CE`

---

## TL;DR

**All 10 assigned attack vectors are BLOCKED.** The Diamond proxy's security boundary is cryptographic -- every path to privileged action reduces to "does the attacker possess the owner's secp256k1 private key?" Without it, the boundary holds with ~128-bit security (ECDLP on secp256k1).

Three LOW-severity hardening opportunities and two INFORMATIONAL findings were identified. Zero critical, high, or medium findings.

---

## Summary Matrix

| # | Vector | Status | Severity | Exploitable? |
|---|--------|--------|----------|-------------|
| 1 | Storage collision | BLOCKED | N/A | No -- keccak256 preimage (~2^128) |
| 2 | Selector clashing | BLOCKED | N/A | No -- diamondCut requires owner |
| 3 | Delegatecall context manipulation | BLOCKED | N/A | No -- msg.sender preserved |
| 4 | Re-initialization | BLOCKED | N/A | No -- constructor-only, no initialize() |
| 5 | Calldata manipulation | BLOCKED | N/A | No -- ABI decoder handles all cases |
| 6 | ERC-2771 / meta-tx spoof | BLOCKED | N/A | No -- uses msg.sender, not _msgSender() |
| 7 | Flash loan + governance | BLOCKED | N/A | No -- no governance mechanism |
| 8 | CREATE2 + selfdestruct | BLOCKED | N/A | No -- no selfdestruct, EIP-6780, CREATE deploy |
| 9 | Reentrancy (withdrawTreasury) | BLOCKED | LOW | No -- CEI pattern + access control |
| 10 | Operator escalation | BLOCKED | N/A | No -- onlyOwner guard |
| A | Direct storage write | BLOCKED | N/A | Impossible (EVM constraint) |
| B | Fallback/receive confusion | BLOCKED | N/A | Non-payable facets reject ETH+calldata |
| C | Force-send ETH | BLOCKED | LOW | Griefing only (attacker loses own ETH) |
| D | Direct facet call | BLOCKED | N/A | Facet context has owner=0x0, always reverts |
| E | Storage mapping collision | BLOCKED | N/A | keccak256 preimage required |
| F | uint16 selectorPosition overflow | BLOCKED | LOW | Owner foot-gun at 65536 selectors |
| G | Gas griefing | BLOCKED | N/A | No attacker-controlled loops |
| H | Missing IDiamondLoupe | N/A | INFO | Not a vulnerability |

---

## Detailed Analysis

### Vector 1: Storage Collision

**Concept:** Diamond pattern uses `keccak256("spoofwallet.diamond.storage")` = `0xbe43dae9...6549` as the base storage slot. If a different facet or contract used a namespace whose keccak256 hash + some offset equaled the owner slot (base+3), it could overwrite the owner.

**Analysis:**
- Owner is stored at slot `0xbe43dae9...654c` (base+3).
- For a collision, another namespace's hash + offset must equal this exact value.
- This requires finding a keccak256 preimage that satisfies specific arithmetic constraints.
- Birthday bound: ~2^128 work. Current best classical attack: Pollard's rho, O(2^128). Infeasible.
- No second namespace exists in the deployed contracts to even attempt collision against.

**PoC:** Verified owner slot reads `0x7a3E312Ec6e20a9F62fE2405938EB9060312E334` via `eth_getStorageAt`.

**Verdict:** BLOCKED. Cryptographic barrier.

---

### Vector 2: Selector Clashing

**Concept:** Deploy a malicious facet with a function whose 4-byte selector collides with an existing one (e.g., `transferOwnership` = `0xf2fde38b`), then register it via `diamondCut` Replace action.

**Analysis:**
- Brute-forcing a function name to match a target 4-byte selector is trivial (~2^16 expected iterations).
- The `diamondCut` Replace action does allow changing the facet address for an existing selector.
- BUT: `diamondCut` has `onlyOwner` modifier. Without the owner key, cannot register any facet.
- Even `diamondCut` Add rejects duplicate selectors: `require(facetAddress == address(0))`.
- With the owner key, selector collision is unnecessary -- you can just call `transferOwnership` directly.

**PoC:** Simulated `diamondCut` call from attacker address -- correctly reverted with "DiamondCut: not owner".

**Verdict:** BLOCKED. Owner key required for registration.

---

### Vector 3: Delegatecall Context Manipulation

**Concept:** In `delegatecall`, `msg.sender` is preserved from the original caller. Could an intermediary contract manipulate the context so `msg.sender` appears to be the owner?

**Analysis:**
- `delegatecall` preserves `msg.sender` and `msg.value` from the ORIGINAL caller.
- If Contract A calls Diamond, `msg.sender` in the facet = Contract A's address.
- If EOA calls Contract A which calls Diamond, `msg.sender` = Contract A (not EOA).
- No chain of calls can make `msg.sender` equal the owner address unless the owner initiated the call.
- `tx.origin` could theoretically be spoofed via phishing (trick owner into calling intermediary), but the contract correctly uses `msg.sender`, not `tx.origin`.

**PoC:** Simulated `setFeeRecipient` call from attacker -- correctly reverted with "Challenge: not owner".

**Verdict:** BLOCKED. `msg.sender` is cryptographically bound to the signer.

---

### Vector 4: Uninitialized Proxy / Re-initialization

**Concept:** Find an `initialize()` function that can be called to overwrite the owner after deployment.

**Analysis:**
- The Diamond uses a constructor for all initialization (owner, feeRecipient, message, selectors).
- Constructor code is NOT stored in deployed bytecode -- it runs once at creation and is discarded.
- No `initialize()`, `init()`, `setup()`, or similar function exists in any facet.
- No `Initializable` pattern (OpenZeppelin) is used. No `initializer` modifier anywhere.
- Deployed bytecode (374 bytes) does not contain any initialization function selector.
- Cannot replay constructor because it is not part of the runtime code.

**PoC:** Bytecode analysis confirms no initialization function in deployed code.

**Verdict:** BLOCKED. Constructor-only initialization is sound against re-init attacks.

---

### Vector 5: Calldata Manipulation

**Concept:** Craft calldata that hits unexpected code paths in the Diamond's fallback.

**Analysis:**
- **Unregistered selector (0xdeadbeef):** Reverts with "Diamond: function does not exist". The `require(facet != address(0))` guard catches all unmapped selectors.
- **Short calldata (1 byte, 0xab):** `msg.sig` = `0xab000000`. Not registered -> reverts.
- **Empty calldata (0 bytes):** Routes to `receive()`, which correctly increments `treasuryBalance`.
- **Extra trailing bytes on valid call:** ABI decoder ignores trailing data. `callPublic()` with 80 extra bytes was accepted and would execute normally. This is standard ABI behavior (not a vulnerability) -- the function reads no parameters, so extra bytes are irrelevant.
- **Malformed ABI encoding:** If parameter offsets point outside calldata bounds, the Solidity decoder reverts. No exploitable path.

**PoC:** All four sub-tests executed against live contract via `eth_call`.

**Verdict:** BLOCKED. Fallback routing and ABI decoding handle all edge cases correctly.

---

### Vector 6: ERC-2771 / Meta-Transaction Spoofing

**Concept:** Append the owner's address to calldata (mimicking ERC-2771 trusted forwarder behavior) to make the contract read a spoofed `_msgSender()`.

**Analysis:**
- ERC-2771 contracts use `_msgSender()` which reads the last 20 bytes of calldata when `msg.sender` is a trusted forwarder.
- This Diamond uses `msg.sender` directly in both `DiamondCutFacet` and `ChallengeFacet` modifiers.
- No `_msgSender()` override. No `isTrustedForwarder()`. No `ERC2771Context` inheritance.
- Appending owner address to `claimSpoof()` calldata: the facet ignores trailing bytes, `msg.sender` is still the attacker.

**PoC:** Simulated `claimSpoof` call with appended owner address from attacker -- correctly reverted.

**Verdict:** BLOCKED. Contract does not implement ERC-2771.

---

### Vector 7: Flash Loan + Governance

**Concept:** Use a flash loan to temporarily acquire tokens/voting power, pass a governance proposal to change the owner, then repay.

**Analysis:**
- Ownership is a simple `address contractOwner` field, not token-weighted voting.
- `transferOwnership` is direct: owner calls, new owner is set immediately. No timelock, no proposal, no voting.
- No governance module, no token dependency, no quorum mechanism.
- Flash loans have nothing to borrow/stake to influence ownership.
- The `pendingOwner` field exists in the struct but is completely unused by any function.

**Verdict:** BLOCKED. No governance mechanism exists to attack.

---

### Vector 8: CREATE2 + Selfdestruct Facet Replacement

**Concept:** If a facet could be selfdestructed, an attacker could redeploy different code at the same address using CREATE2, causing the Diamond to delegatecall into malicious code.

**Analysis:**
- **No selfdestruct:** Neither facet nor the Diamond contains `selfdestruct` in source code.
- **EIP-6780 (Dencun, March 2024):** Even if `selfdestruct` existed, it only clears code and storage when called in the SAME transaction as contract creation. These contracts were created in past transactions -- `selfdestruct` would only send ETH balance, not clear code.
- **CREATE, not CREATE2:** Facets were deployed via `ethers.ContractFactory.deploy()`, which uses `CREATE` (nonce-based address derivation). Not CREATE2. No metamorphic proxy pattern.
- **Metamorphic contract pre-requisite:** Even with CREATE2, different bytecode produces a different address (`keccak256(0xff ++ deployer ++ salt ++ initCodeHash)`). The classic metamorphic trick (CREATE2 factory -> CREATE inner contract) requires the original deployer to use this pattern from the start. It was not used here.

**PoC:** Verified both facets have live code: DiamondCutFacet (2699 bytes), ChallengeFacet (3515 bytes).

**Verdict:** BLOCKED. No selfdestruct, EIP-6780, CREATE deployment.

---

### Vector 9: Reentrancy via withdrawTreasury

**Concept:** The external call `payable(to).call{value: amount}("")` in `withdrawTreasury` gives control to the recipient, who could re-enter the Diamond.

**Analysis:**
```solidity
function withdrawTreasury(address to, uint256 amount) external onlyOwnerOrOperator {
    require(to != address(0), "Zero address");
    DiamondStorage.DiamondState storage ds = DiamondStorage.diamondStorage();
    require(amount <= ds.treasuryBalance, "Insufficient balance");
    ds.treasuryBalance -= amount;                              // EFFECT before interaction
    (bool ok,) = payable(to).call{value: amount}("");          // INTERACTION
    require(ok, "Transfer failed");
    emit TreasuryWithdrawal(to, amount);
}
```

- **Access control:** `onlyOwnerOrOperator` gates entry. Attacker cannot call without owner key.
- **CEI pattern:** `ds.treasuryBalance -= amount` happens BEFORE the external call. A re-entrant call to `withdrawTreasury` would fail on `require(amount <= ds.treasuryBalance)` because the balance was already decremented.
- **Cross-function reentrancy:** The recipient could call `callPublic()` (harmless counter increment) or any owner function (would fail -- recipient contract is not owner).
- **No reentrancy guard:** The function lacks `nonReentrant` / mutex modifier. While CEI mitigates the classic drain, a `ReentrancyGuard` would provide defense-in-depth.

**PoC:** Wrote `poc-reentrancy-attacker.sol` demonstrating the theoretical attack path. Cannot execute without operator status.

**Severity:** LOW. Access control + CEI pattern prevent exploitation. Missing `ReentrancyGuard` is a hardening opportunity.

**Recommended fix:** Add OpenZeppelin `ReentrancyGuard` (or a Diamond-compatible equivalent using Diamond storage) to `withdrawTreasury`.

---

### Vector 10: Operator Escalation

**Concept:** Find a way to grant attacker operator status without owner cooperation.

**Analysis:**
- `approveOperator(address, bool)` is the ONLY function that writes to `ds.approvedOperators`.
- It has `onlyOwner` modifier. `msg.sender` must equal `ds.contractOwner`.
- No other function touches the `approvedOperators` mapping.
- Storage slot for `approvedOperators[attacker]` = `keccak256(abi.encode(attacker, base+9))`. Cannot be written externally.
- Front-running a pending `approveOperator` tx: attacker is not yet operator when the tx is pending, so there is no window to exploit.
- Storage mapping collision (mapping key whose keccak256 equals owner slot): requires keccak256 preimage attack. Infeasible.

**PoC:** `approveOperator` from attacker address reverted. `isOperator(attacker)` returns false.

**Verdict:** BLOCKED. Only owner can grant operator status.

---

## Novel Vectors (Beyond Assigned 10)

### Novel A: Direct Storage Write

Cannot write to another contract's storage from an external transaction. Fundamental EVM architecture constraint. **IMPOSSIBLE.**

### Novel B: Fallback vs Receive Confusion

Sending ETH + function calldata: the `fallback()` routes to the facet via `delegatecall`. Facet functions are NOT marked `payable`, so the Solidity compiler inserts `require(msg.value == 0)` at the start. The call reverts.

Only `receive()` (empty calldata + value) successfully updates `treasuryBalance`. **SAFE** -- but if a future facet function were marked `payable` without updating `treasuryBalance`, ETH would enter untracked. Note for future development.

### Novel C: Force-Send ETH (Bypass receive())

A contract can force-send ETH via `selfdestruct(diamondAddress)`. This bypasses `receive()` and does NOT increment `ds.treasuryBalance`. The ETH enters the Diamond but is permanently stuck -- `withdrawTreasury` only withdraws up to `ds.treasuryBalance`.

**Impact:** Griefing only. Attacker loses their own ETH. No theft, no access bypass.

**Severity:** LOW (informational).

### Novel D: Direct Facet Call

Calling facet contracts directly (not through Diamond) executes in the FACET's storage context, not Diamond's. The facet's storage at the Diamond storage position is uninitialized:
- `ds.contractOwner = address(0)` in facet context.
- `onlyOwner` requires `msg.sender == address(0)`. No EOA has the private key for `address(0)`.
- Therefore, `onlyOwner` always reverts on direct facet calls.
- `callPublic()` called directly would modify the FACET's storage, not Diamond's. Harmless.

**Verified on-chain:** `owner()` called on DiamondCutFacet directly returns `0x0000000000000000000000000000000000000000`.

**SAFE.**

### Novel E: Storage Mapping Key Collision

To set `approvedOperators[attacker] = true` via collision, we need:
`keccak256(abi.encode(addr, base+9))` to equal a slot that is already `true`.
No such slot exists (no operators approved). Even if one did, the collision would require keccak256 preimage. **INFEASIBLE.**

### Novel F: uint16 selectorPosition Overflow

`FacetAddressAndSelectorPosition.selectorPosition` is `uint16` (max 65535). If >65535 selectors were registered via `diamondCut`, the position would silently truncate, corrupting the selector removal logic.

**Impact:** Owner-only foot-gun. Attacker cannot register selectors. Would require 65536+ `diamondCut` calls, each costing gas.

**Severity:** LOW (design note).

**Recommended fix:** Add `require(ds.selectors.length < type(uint16).max)` in the Add action of `diamondCut`.

### Novel G: Gas Griefing

All facet functions are O(1) except `setMessage` (O(n) on string length, owner-only). No attacker-controlled loops. **NOT EXPLOITABLE.**

### Novel H: Missing IDiamondLoupe (EIP-2535)

The Diamond does not implement `IDiamondLoupe` (facet enumeration functions). This is a standards compliance gap, not a security vulnerability. On-chain introspection of the facet mapping is not possible without reading storage directly.

**Severity:** INFORMATIONAL.

---

## Findings Summary

### LOW-1: Missing ReentrancyGuard on withdrawTreasury

**Severity:** LOW
**Impact:** Defense-in-depth gap. Currently mitigated by CEI pattern and access control.
**Repro:** See `scripts/diamond-exploits/poc-reentrancy-attacker.sol`
**Fix:** Add Diamond-storage-based reentrancy lock to `withdrawTreasury`:
```solidity
// In DiamondStorage.sol, add to DiamondState:
uint256 reentrancyStatus; // 1 = not entered, 2 = entered

// In ChallengeFacet.sol:
modifier nonReentrant() {
    DiamondStorage.DiamondState storage ds = DiamondStorage.diamondStorage();
    require(ds.reentrancyStatus != 2, "ReentrancyGuard: reentrant call");
    ds.reentrancyStatus = 2;
    _;
    ds.reentrancyStatus = 1;
}
```

### LOW-2: Force-Sent ETH Permanently Locked

**Severity:** LOW
**Impact:** Griefing vector. Attacker can lock their own ETH in Diamond permanently.
**Repro:** Deploy `ForceFeeder{value: X}(DIAMOND_ADDRESS)` -- see `scripts/diamond-exploits/poc-force-send-eth.sol`
**Fix:** Add a sweep function or track `address(this).balance` instead of / alongside `treasuryBalance`:
```solidity
function sweepExcessETH() external onlyOwner {
    uint256 excess = address(this).balance - ds.treasuryBalance;
    if (excess > 0) {
        // recover force-sent ETH
    }
}
```

### LOW-3: uint16 selectorPosition Overflow

**Severity:** LOW
**Impact:** Owner foot-gun at >65535 selectors. Corrupts removal logic.
**Repro:** Call `diamondCut` Add action 65536+ times (requires owner key + massive gas).
**Fix:** Add bounds check: `require(ds.selectors.length < type(uint16).max, "Too many selectors");`

### INFO-1: Missing IDiamondLoupe

**Severity:** INFORMATIONAL
**Impact:** No on-chain facet enumeration. Standards compliance gap.
**Fix:** Deploy a DiamondLoupeFacet implementing `facets()`, `facetFunctionSelectors()`, `facetAddresses()`, `facetAddress()`.

### INFO-2: Unused pendingOwner Field

**Severity:** INFORMATIONAL
**Impact:** Dead code in struct. No functional impact.
**Fix:** Remove from `DiamondState` struct, or implement two-step ownership transfer using it.

---

## Security Boundary

The Diamond's access control model is sound. Every privileged operation requires `msg.sender == ds.contractOwner`, and `msg.sender` is derived from the transaction's ECDSA signature via `ecrecover` at the protocol level. The complete attack surface reduces to:

```
Can the attacker sign a transaction that recovers to 0x7a3E312Ec6e20a9F62fE2405938EB9060312E334?
```

This requires solving the Elliptic Curve Discrete Logarithm Problem on secp256k1, which has approximately 128 bits of security. No known classical algorithm achieves this in feasible time. Shor's algorithm on a quantum computer could, but requires ~2500 logical qubits (estimated 10-20+ years away from practical realization).

**The boundary is cryptographic, not architectural.**

---

## PoC Scripts

| Script | Purpose | Status |
|--------|---------|--------|
| `scripts/diamond-exploits/full-attack-suite.js` | Automated test of all 10+ vectors via eth_call | All vectors BLOCKED |
| `scripts/diamond-exploits/vector-8-9-10-analysis.js` | Detailed analysis of CREATE2, reentrancy, operator | All BLOCKED |
| `scripts/diamond-exploits/novel-vectors.js` | Novel vectors A-H beyond assigned 10 | All BLOCKED |
| `scripts/diamond-exploits/poc-reentrancy-attacker.sol` | Reentrancy attacker contract (non-functional) | Cannot deploy without operator status |
| `scripts/diamond-exploits/poc-force-send-eth.sol` | Force-send ETH griefing contract | Functional but self-griefing only |
| `scripts/diamond-exploits/poc-selector-collision.sol` | Malicious facet with collision selector | Cannot register without owner key |

---

## Recommendations for Defender (Ren / Cyrus)

1. **Add ReentrancyGuard** to `withdrawTreasury` (defense-in-depth).
2. **Add uint16 overflow check** in `diamondCut` Add action.
3. **Consider adding a sweep function** for force-sent ETH recovery.
4. **Implement IDiamondLoupe** for standards compliance.
5. **Remove or use `pendingOwner`** -- either implement two-step transfer or remove the field.
6. **Consider two-step ownership transfer** -- the current single-step `transferOwnership` means a typo in the new owner address permanently locks the contract. Using `pendingOwner` + `acceptOwnership` pattern is safer.

All findings are LOW or INFORMATIONAL. No critical action required.
