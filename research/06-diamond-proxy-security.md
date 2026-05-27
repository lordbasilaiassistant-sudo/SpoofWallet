# 06 -- Diamond Proxy (EIP-2535) Security: Attack Surface Analysis

## Key Takeaway

The Diamond proxy pattern (EIP-2535) introduces a qualitatively different attack surface compared to simple `onlyOwner` contracts. The combination of `delegatecall`-based function dispatch, shared storage across facets, and runtime-modifiable function routing creates attack vectors that do not exist in monolithic contracts. This paper catalogs those vectors, analyzes their applicability to the SpoofWallet Diamond at `0x0D5d767Dfad78a81237bCa60d986d68bffE9B174`, and explains why the Diamond is the right target for adversarial security testing.

---

## 1. Why Diamond Is the Right Test Target

### 1.1 Real-World Adoption

The Diamond pattern is not academic. It is deployed in production by major DeFi protocols:

- **Aave V3** uses a Diamond-like proxy architecture for its pool contracts, enabling modular upgrades of lending logic without migrating liquidity.
- **Balancer V2** uses a vault pattern with Diamond-like facet dispatch for swap and pool logic.
- **Louper.dev** indexes over 4,000 Diamond contracts on Ethereum mainnet alone (as of early 2026).
- **EIP-2535** was authored by Nick Mudge and has been in the EIPs repository since 2020, with multiple reference implementations.

Any vulnerability in the Diamond pattern has broad real-world impact.

### 1.2 Complexity Creates Attack Surface

The Diamond pattern has more moving parts than a simple contract:

| Component | Simple Contract | Diamond Proxy |
|-----------|----------------|---------------|
| Entry point | Direct function call | `fallback()` with selector lookup |
| Code execution | In-contract | `delegatecall` to external facet |
| Storage | Single contract's storage | Shared storage via library + slot offset |
| Function routing | Compile-time (ABI) | Runtime (selector-to-facet mapping) |
| Upgradeability | None (or simple proxy) | Per-function granularity |
| Owner surface area | 1-2 admin functions | `diamondCut` controls ALL routing |

More components means more interaction points. More interaction points means more potential for unexpected behavior.

### 1.3 The Specific Escalation from SpoofTest to Diamond

The SpoofWallet project started with two simple contracts:

1. **SpoofTest** (`0x7b2e...3F4E`): Single `owner` variable, single `require(msg.sender == owner)` check. Attack surface: essentially zero beyond the ECDSA guarantee. There is one function to protect and one guard protecting it.

2. **SpoofChallenge** (`0x2c79...BA6b`): Enhanced version with `feeRecipient`, `spoofSucceeded`, ownership transfer, and multiple guarded functions. More complex, but still a monolithic contract with direct storage access. Attack surface: broader but still straightforward.

3. **Diamond** (`0x0D5d...B174`): delegatecall proxy with facet dispatch, shared storage via library, and a `diamondCut` function that can add/replace/remove any function's implementation at runtime. This is where the real security questions live.

The progression is deliberate: validate that `msg.sender` is cryptographically secure (papers 00-02), then test whether architectural complexity (proxy + delegatecall + shared storage) introduces ways to circumvent that security without breaking the cryptography.

---

## 2. Diamond Architecture Deep Dive

### 2.1 The SpoofWallet Diamond

Deployed at `0x0D5d767Dfad78a81237bCa60d986d68bffE9B174` on Base mainnet.

**Components:**

```
Diamond.sol (proxy)
  |
  |-- fallback() -> looks up facet by msg.sig, delegatecalls
  |-- receive() -> credits msg.value to treasuryBalance
  |
DiamondStorage.sol (storage library)
  |
  |-- DIAMOND_STORAGE_POSITION = keccak256("spoofwallet.diamond.storage")
  |-- DiamondState struct: owner, feeRecipient, message, counters,
  |                        selector-to-facet mapping, operators, treasury
  |
DiamondCutFacet.sol (admin facet)
  |
  |-- diamondCut(address, bytes4[], FacetCutAction) -- onlyOwner
  |-- transferOwnership(address) -- onlyOwner
  |-- owner() -- view
  |
ChallengeFacet.sol (application facet)
  |
  |-- callPublic() -- no access control
  |-- setMessage(string) -- onlyOwner
  |-- setFeeRecipient(address) -- onlyOwner
  |-- claimSpoof() -- onlyOwner
  |-- approveOperator(address, bool) -- onlyOwner
  |-- withdrawTreasury(address, uint256) -- onlyOwnerOrOperator
  |-- getState() -- view
  |-- isOperator(address) -- view
```

**Owner:** `0x7a3E312Ec6e20a9F62fE2405938EB9060312E334`

### 2.2 The Fallback Dispatch Mechanism

The core of the Diamond pattern is the `fallback()` function:

```solidity
fallback() external payable {
    DiamondStorage.DiamondState storage ds = DiamondStorage.diamondStorage();
    address facet = ds.facetAddressAndSelectorPosition[msg.sig].facetAddress;
    require(facet != address(0), "Diamond: function does not exist");

    assembly {
        calldatacopy(0, 0, calldatasize())
        let result := delegatecall(gas(), facet, 0, calldatasize(), 0, 0)
        returndatacopy(0, 0, returndatasize())
        switch result
        case 0 { revert(0, returndatasize()) }
        default { return(0, returndatasize()) }
    }
}
```

This is the single entry point for all non-receive function calls. It:

1. Reads the first 4 bytes of calldata (`msg.sig`) to identify the function selector.
2. Looks up the facet address mapped to that selector in Diamond storage.
3. `delegatecall`s the facet with the full calldata.
4. Returns or reverts based on the facet's result.

**Security-critical properties:**
- The selector-to-facet mapping is stored in Diamond storage, which is writable only by `diamondCut`.
- `diamondCut` is guarded by `onlyOwner`.
- Therefore, the routing table is only modifiable by the owner.

**But:** If any vulnerability allows an attacker to modify Diamond storage directly (bypassing `diamondCut`), the attacker can reroute any function to a malicious facet.

---

## 3. Attack Surface Catalog

### 3.1 delegatecall Context Attacks

**Vector:** `delegatecall` executes the facet's code in the Diamond's storage context. This means the facet code can read and write ANY storage slot in the Diamond, not just the slots "intended" for that facet.

**The risk:** If a malicious facet is added (either by a compromised owner or via a vulnerability in `diamondCut`), it has unrestricted write access to all Diamond storage, including:
- The owner address (`ds.contractOwner`)
- The selector-to-facet mapping (`ds.facetAddressAndSelectorPosition`)
- The treasury balance (`ds.treasuryBalance`)
- Operator approvals (`ds.approvedOperators`)

**Concrete attack scenario:**

```solidity
// Malicious facet that takes over ownership
contract MaliciousFacet {
    function innocentLookingFunction() external {
        // DiamondStorage slot position
        bytes32 slot = keccak256("spoofwallet.diamond.storage");
        // contractOwner is the 4th field after three mappings/arrays
        // Exact slot calculation depends on struct layout
        assembly {
            // Overwrite the owner slot directly
            sstore(add(slot, OWNER_OFFSET), caller())
        }
    }
}
```

**Mitigation in SpoofWallet Diamond:** The `diamondCut` function is `onlyOwner`, so adding a malicious facet requires the owner's private key. The risk exists only if:
1. The owner key is compromised.
2. A legitimate facet contains a bug that allows arbitrary storage writes.
3. A facet has an unprotected `selfdestruct` or `delegatecall` that an attacker can exploit.

**Severity:** CRITICAL if exploitable, but requires a precondition (owner compromise or facet bug).

### 3.2 Storage Slot Collision

**Vector:** The Diamond pattern uses a fixed storage slot position derived from `keccak256("spoofwallet.diamond.storage")`. All state is stored at offsets from this base slot. If two facets independently define storage that maps to the same slot, they will read/write each other's data.

**The SpoofWallet approach:**

```solidity
library DiamondStorage {
    bytes32 constant DIAMOND_STORAGE_POSITION = keccak256("spoofwallet.diamond.storage");

    function diamondStorage() internal pure returns (DiamondState storage ds) {
        bytes32 position = DIAMOND_STORAGE_POSITION;
        assembly {
            ds.slot := position
        }
    }
}
```

Both `DiamondCutFacet` and `ChallengeFacet` import and use the same `DiamondStorage` library with the same slot position. This is correct -- they SHOULD share storage because they need to access the same owner, selectors, and state.

**The risk emerges when:**
1. A new facet is added that uses its OWN storage layout at the same slot position, or at a slot that overlaps with the Diamond storage struct's fields.
2. A facet uses raw `sstore`/`sload` at slot 0 or another low-numbered slot, which could collide with the compiler's default storage layout (though the Diamond uses assembly-positioned storage to avoid this).
3. A facet inherits from a contract that has its own state variables, which the compiler places at slot 0, 1, 2, etc. -- potentially colliding with other facets' inherited state.

**Concrete collision scenario:**

```solidity
// BAD: Facet with its own state variables
contract BadFacet {
    // These will be at slots 0, 1, 2 in the Diamond's storage
    address public someAddress;    // slot 0
    uint256 public someValue;      // slot 1
    bool public someFlag;          // slot 2

    function doSomething() external {
        someAddress = msg.sender;  // Writes to Diamond's slot 0!
        // What else is at Diamond's slot 0? Could be anything.
    }
}
```

**Why SpoofWallet Diamond is safe (currently):** Both facets use `DiamondStorage.diamondStorage()` exclusively and have no state variables of their own. The storage is positioned at `keccak256("spoofwallet.diamond.storage")`, which is at a very high slot number, far from slot 0.

**But:** Any future facet that declares its own state variables (not using the `DiamondStorage` library) WILL create a collision risk. This is the most common Diamond vulnerability in practice.

**Mitigation best practice:** Every facet MUST use the Diamond storage library for ALL state. No facet should declare `public` or `private` state variables. Enforce this via code review and static analysis.

### 3.3 Facet Replacement as an Attack Vector

**Vector:** The `diamondCut` function supports three actions: Add, Replace, and Remove. The Replace action changes which facet address a selector points to, without removing it from the selector array.

```solidity
} else if (_action == FacetCutAction.Replace) {
    for (uint256 i = 0; i < _selectors.length; i++) {
        require(
            ds.facetAddressAndSelectorPosition[_selectors[i]].facetAddress != address(0),
            "DiamondCut: selector not found"
        );
        ds.facetAddressAndSelectorPosition[_selectors[i]].facetAddress = _facetAddress;
    }
}
```

**The risk:** If an attacker gains access to `diamondCut` (via owner key compromise or a bug), they can replace ANY function's implementation. For example:

- Replace `withdrawTreasury`'s implementation with one that has no access control.
- Replace `owner()` view function with one that returns the attacker's address.
- Replace `diamondCut` itself with a version that has no `onlyOwner` check, then use that to replace everything else.

**The nuclear option:** Replace the selector for `diamondCut` itself. If `diamondCut` is replaced with a malicious implementation, the attacker controls all future routing changes. The legitimate owner loses the ability to fix anything.

**Specific risk in SpoofWallet Diamond:**

The `transferOwnership` function in `DiamondCutFacet` performs an immediate, single-step transfer:

```solidity
function transferOwnership(address _newOwner) external onlyOwner {
    require(_newOwner != address(0), "DiamondCut: zero address");
    DiamondStorage.DiamondState storage ds = DiamondStorage.diamondStorage();
    address previous = ds.contractOwner;
    ds.contractOwner = _newOwner;
    emit OwnershipTransferred(previous, _newOwner);
}
```

This is a known anti-pattern. If the owner accidentally calls `transferOwnership` with a wrong address (typo, clipboard hijack), ownership is irrecoverably lost. The Diamond storage even has a `pendingOwner` field that is currently unused -- evidence that a two-step transfer was considered but not implemented.

**Recommendation:** Implement two-step ownership transfer using the existing `pendingOwner` field:

```solidity
function transferOwnership(address _newOwner) external onlyOwner {
    require(_newOwner != address(0), "DiamondCut: zero address");
    DiamondStorage.DiamondState storage ds = DiamondStorage.diamondStorage();
    ds.pendingOwner = _newOwner;
    emit OwnershipTransferInitiated(ds.contractOwner, _newOwner);
}

function acceptOwnership() external {
    DiamondStorage.DiamondState storage ds = DiamondStorage.diamondStorage();
    require(msg.sender == ds.pendingOwner, "DiamondCut: not pending owner");
    address previous = ds.contractOwner;
    ds.contractOwner = msg.sender;
    ds.pendingOwner = address(0);
    emit OwnershipTransferred(previous, msg.sender);
}
```

### 3.4 Selector Collision / Function Signature Grinding

**Vector:** Function selectors are the first 4 bytes of the Keccak-256 hash of the function signature. The selector space is 2^32 (~4.3 billion). With enough computation, an attacker can find a function signature that produces the same 4-byte selector as an existing protected function.

**Example:** `transfer(address,uint256)` has selector `0xa9059cbb`. If an attacker finds another function name (e.g., `transfer_oMaKqwg(address,uint256)`) that hashes to the same selector, and that function has different access control logic, they could try to exploit the collision.

**Why this is mostly theoretical for Diamonds:**

1. In a normal contract, selectors are fixed at compile time. The Solidity compiler rejects duplicate selectors in the same contract.
2. In a Diamond, selectors are registered at deployment or via `diamondCut`. The `Add` action checks that the selector does not already exist:
   ```solidity
   require(
       ds.facetAddressAndSelectorPosition[_selectors[i]].facetAddress == address(0),
       "DiamondCut: selector already added"
   );
   ```
3. To exploit a collision, the attacker would need to use the `Replace` action, which requires `onlyOwner`.

**Where it becomes relevant:** If a governance mechanism (multisig, DAO vote) controls `diamondCut`, and the governance proposal displays a human-readable function name while the actual selector has been ground to collide with a different function, voters might approve a malicious replacement without realizing it.

**Severity:** LOW for the current SpoofWallet Diamond (single owner, no governance). MEDIUM for production Diamonds with DAO governance.

### 3.5 Reentrancy via Cross-Facet Calls

**Vector:** The `withdrawTreasury` function sends ETH to an arbitrary address:

```solidity
function withdrawTreasury(address to, uint256 amount) external onlyOwnerOrOperator {
    require(to != address(0), "Zero address");
    DiamondStorage.DiamondState storage ds = DiamondStorage.diamondStorage();
    require(amount <= ds.treasuryBalance, "Insufficient balance");
    ds.treasuryBalance -= amount;
    (bool ok,) = payable(to).call{value: amount}("");
    require(ok, "Transfer failed");
    emit TreasuryWithdrawal(to, amount);
}
```

This function follows the checks-effects-interactions pattern (balance is decremented BEFORE the external call), which prevents classic reentrancy. However, there are subtleties in the Diamond context:

1. **Cross-facet reentrancy:** The `to.call{value: amount}("")` triggers the recipient's `receive()` or `fallback()`. If the recipient is a contract, it could call back into the Diamond's `fallback()`, which would dispatch to any registered facet. If another facet has a function that reads `treasuryBalance` and makes decisions based on it, the reentrant call would see the decremented balance. This is safe IF the balance decrement is the only relevant state change. But if future facets add state that should be consistent with `treasuryBalance`, the reentrancy could create inconsistencies.

2. **Operator reentrancy:** The function uses `onlyOwnerOrOperator`. If an approved operator is a contract, and that contract calls `withdrawTreasury` which then calls the operator back, the operator could reenter `withdrawTreasury` again. The checks-effects pattern protects against double-withdrawal of the same funds, but the reentrant call would still execute the `onlyOwnerOrOperator` check, which would pass (since the operator is still approved).

**Severity:** LOW for current implementation (CEI pattern is correct). MEDIUM if new facets are added that create cross-facet state dependencies.

### 3.6 Diamond Initialization Attacks

**Vector:** The Diamond constructor initializes storage in a single transaction:

```solidity
constructor(address _owner, FacetInit[] memory _facets) {
    DiamondStorage.DiamondState storage ds = DiamondStorage.diamondStorage();
    ds.contractOwner = _owner;
    ds.feeRecipient = _owner;
    ds.message = "Diamond initialized - break me if you can";

    for (uint256 i = 0; i < _facets.length; i++) {
        // ... register selectors
    }
}
```

**Post-deployment risk:** The constructor runs once at deployment. If the deployment transaction is front-run on a chain with a public mempool, the attacker could deploy a different Diamond at the same address (via CREATE2 with the same salt). On Base (L2 with a sequencer), the mempool is not public, so this risk is minimal.

**Initialization-gap risk:** If a Diamond is deployed via a factory using CREATE2, and the factory separates deployment from initialization (deploy first, then call `initialize()`), there is a window between deployment and initialization where an attacker could call `initialize()` first and set themselves as owner. The SpoofWallet Diamond does not use this pattern (owner is set in the constructor), so this is not applicable.

### 3.7 facet selfdestruct / DELEGATECALL to selfdestruct

**Vector (HISTORICAL):** Prior to the Dencun upgrade (EIP-6780, March 2024), a facet that contained `selfdestruct` could be called via `delegatecall`, which would destroy the Diamond proxy itself (since `delegatecall` executes in the caller's context). This would permanently brick the Diamond, losing all state and funds.

**Current status:** EIP-6780 restricted `selfdestruct` to only work within the same transaction as contract creation. A `selfdestruct` in a facet called via `delegatecall` will no longer destroy the Diamond (it will transfer ETH but not delete the contract). This vector is effectively closed on all EVM chains that have adopted Dencun (including Ethereum mainnet and Base).

**Residual risk:** A facet with `selfdestruct` could still drain the Diamond's ETH balance (the ETH is sent to the beneficiary of the selfdestruct), even though the contract is not destroyed. This is a fund extraction vector if the facet's `selfdestruct` is callable without proper access control.

**Severity:** LOW (post-Dencun). Would be CRITICAL on pre-Dencun chains.

---

## 4. Comparison: Simple Contract vs. Diamond

| Security Property | SpoofTest / SpoofChallenge | Diamond |
|---|---|---|
| Attack surface for ownership bypass | `msg.sender == owner` (1 check) | `msg.sender == ds.contractOwner` (same check, but storage is shared and writable by any facet via delegatecall) |
| Storage isolation | Compiler-enforced (single contract) | Convention-enforced (all facets must use DiamondStorage library) |
| Upgradeability risk | None (immutable) | `diamondCut` can replace any function's implementation |
| Function routing trust | Compiler-verified (ABI) | Runtime mapping (modifiable by owner) |
| Reentrancy surface | Single contract, easy to audit | Cross-facet interactions, harder to reason about |
| Initialization safety | Constructor sets owner, done | Constructor sets owner, but facets could have their own init logic |
| Ownership transfer | Single-step (SpoofChallenge) | Single-step (DiamondCutFacet) -- both should be two-step |
| Code at rest | All in one file, auditable | Split across facets, requires understanding the routing |

**Key insight:** The ECDSA guarantee (msg.sender cannot be spoofed) is equally strong in both architectures. What changes is the set of consequences if any other vulnerability is found. In a simple contract, a bug in one function affects that function. In a Diamond, a bug in one facet potentially affects all storage (because delegatecall shares the storage context).

---

## 5. Specific Findings for SpoofWallet Diamond

### Finding 1: Single-Step Ownership Transfer [MEDIUM]

**Location:** `DiamondCutFacet.transferOwnership()` (line 67-73)

**Issue:** Immediate, irrevocable ownership transfer. A typo or clipboard hijack in the `_newOwner` parameter permanently locks the Diamond.

**Evidence:** The `DiamondState` struct includes a `pendingOwner` field (line 23 of DiamondStorage.sol) that is never used, suggesting this was a known concern during development.

**Recommendation:** Implement two-step transfer as described in section 3.3.

### Finding 2: No Reentrancy Guard on withdrawTreasury [LOW]

**Location:** `ChallengeFacet.withdrawTreasury()` (line 64-72)

**Issue:** The function correctly follows CEI (checks-effects-interactions), but does not use a reentrancy guard. If future facets introduce state that should be atomically consistent with `treasuryBalance`, cross-facet reentrancy becomes a risk.

**Recommendation:** Add a reentrancy guard to `withdrawTreasury`. The guard can be implemented as a boolean in DiamondStorage:

```solidity
// In DiamondStorage struct:
bool reentrancyLocked;

// Modifier in facets:
modifier nonReentrant() {
    DiamondStorage.DiamondState storage ds = DiamondStorage.diamondStorage();
    require(!ds.reentrancyLocked, "Reentrant call");
    ds.reentrancyLocked = true;
    _;
    ds.reentrancyLocked = false;
}
```

### Finding 3: diamondCut Has No Timelock [INFO]

**Location:** `DiamondCutFacet.diamondCut()` (line 18-65)

**Issue:** The owner can add, replace, or remove any function's implementation in a single transaction with no delay. In production, this should have a timelock to allow users to exit before malicious changes take effect.

**Context:** For a security research testbed, immediate `diamondCut` is appropriate (we want to test rapid facet changes). For a production contract holding user funds, this would be a MEDIUM finding.

### Finding 4: No Event Indexed Data for Selector Changes [INFO]

**Location:** `DiamondCutFacet.diamondCut()` event emission

**Issue:** The `DiamondCut` event emits the facet address and selectors, but the selectors array is not easily parseable from event logs (it's an unindexed dynamic array). Off-chain monitoring tools would need to decode the full event data to understand what changed.

**Recommendation:** Emit individual events per selector change for easier monitoring, or add an indexed hash of the selectors array.

### Finding 5: Operator Approval Has No Expiry [LOW]

**Location:** `ChallengeFacet.approveOperator()` (line 58-61)

**Issue:** Once an operator is approved, they remain approved indefinitely until the owner explicitly revokes. If an operator contract is compromised, it retains access to `withdrawTreasury` until the owner notices.

**Recommendation:** Add an expiry timestamp to operator approvals, or implement a per-withdrawal allowance.

---

## 6. The Diamond as Adversarial Testing Ground

The Diamond proxy is the ideal target for the adversarial self-play framework (paper 05) because:

1. **Rich attack surface.** Five distinct vector categories (delegatecall context, storage collision, facet replacement, selector collision, reentrancy) provide enough diversity for meaningful episodes.

2. **Modifiable at runtime.** The attacker can propose (and the defender can deploy) new facets, creating a dynamic game where the target changes between episodes.

3. **Realistic architecture.** The same pattern secures billions of dollars in DeFi. Findings transfer to production systems.

4. **Layered defense.** The Diamond has multiple defense layers (ECDSA for msg.sender, onlyOwner for diamondCut, selector registration for routing, storage library for isolation). Each layer can be tested independently.

5. **Clear escalation path.** Start by testing msg.sender bypass (should be impossible -- papers 00-02 confirmed this). Then test Diamond-specific vectors. Then test cross-facet interactions. Each level is harder than the last.

---

## 7. Open Attack Vectors for Future Episodes

The following vectors have NOT been tested yet and should be the focus of upcoming attacker-vs-defender episodes:

| # | Vector | Category | Target | Hypothesis |
|---|--------|----------|--------|-----------|
| 1 | Storage slot enumeration | 3.2 | DiamondStorage | Can an attacker determine the exact storage layout by probing slots via eth_getStorageAt? |
| 2 | Selector grinding | 3.4 | DiamondCutFacet | Can an attacker find a function signature that collides with diamondCut's selector? |
| 3 | Cross-facet reentrancy | 3.5 | ChallengeFacet.withdrawTreasury | Can a reentrant call via withdrawTreasury manipulate state in a way that bypasses access controls? |
| 4 | Malicious facet via social engineering | 3.3 | DiamondCutFacet | If the owner is tricked into adding a facet, what is the maximum damage in a single transaction? |
| 5 | Front-running diamondCut | 3.3 | DiamondCutFacet | On Base (sequencer-ordered), can a transaction be inserted between a diamondCut and a subsequent call that relies on the old routing? |
| 6 | Operator privilege escalation | 3.5 | ChallengeFacet | Can an approved operator escalate to owner privileges via a crafted interaction? |
| 7 | Storage layout inference + direct sstore | 3.1 | Diamond | If an attacker deploys their own contract and delegatecalls into it, can they overwrite Diamond storage? (Requires executing code in Diamond context, which requires diamondCut -- circular.) |

---

## References

1. EIP-2535: Diamonds, Multi-Facet Proxy -- https://eips.ethereum.org/EIPS/eip-2535
2. Nick Mudge. "Understanding Diamonds on Ethereum." https://eip2535diamonds.substack.com/
3. EIP-6780: SELFDESTRUCT only in same transaction -- https://eips.ethereum.org/EIPS/eip-6780
4. EIP-1967: Proxy Storage Slots -- https://eips.ethereum.org/EIPS/eip-1967
5. OpenZeppelin Proxy Patterns -- https://docs.openzeppelin.com/contracts/5.x/api/proxy
6. Trail of Bits. "Contract upgrade anti-patterns." https://blog.trailofbits.com/2018/09/05/contract-upgrade-anti-patterns/
7. Euler Finance exploit post-mortem (March 2023) -- https://www.euler.finance/blog/euler-exploit-post-mortem
8. EIP-2771: Secure Protocol for Native Meta Transactions -- https://eips.ethereum.org/EIPS/eip-2771
9. Ethereum Yellow Paper, Appendix H: Virtual Machine Specification (DELEGATECALL) -- https://ethereum.github.io/yellowpaper/paper.pdf
10. Louper -- The Diamond Inspector -- https://louper.dev/
