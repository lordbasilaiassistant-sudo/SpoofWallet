# 02 -- Attack Surface Analysis: All Vectors for Address Spoofing

## Key Takeaway

We enumerate 9 distinct attack vectors for making a contract "see" a different address than the actual transaction signer. Of these, **only 3 can alter what the contract sees as its caller**, and all 3 require either (a) the contract to opt in to the pattern (EIP-2771, EIP-4337) or (b) a compromised/malicious node. None can bypass a standard `require(msg.sender == owner)` guard on a correctly-written contract without possessing the owner's private key.

The browser-level provider injection tested by this project falls in the category of "fools the UI, not the chain."

---

## Attack Vector Taxonomy

```
Category A: UI-Only Spoofs (fool the dApp, not the chain)
  [A1] Provider injection (window.ethereum override)
  [A2] eth_call from-field manipulation
  [A3] Fake event/log injection via malicious RPC

Category B: Protocol-Level Vectors (require special contract design)
  [B1] Meta-transactions via EIP-2771 trusted forwarder
  [B2] Account abstraction via EIP-4337
  [B3] Proxy/delegatecall context manipulation

Category C: Infrastructure Attacks (require compromised nodes/networks)
  [C1] Malicious RPC endpoint
  [C2] Consensus-level attack (51% / validator collusion)
  [C3] Preimage attack on ecrecover (break ECDSA)
```

---

## Category A: UI-Only Spoofs

### A1. Provider Injection (window.ethereum Override)

**This is what the SpoofWallet extension does.**

**Mechanism:** A Chrome extension content script runs in the page context (or injects via `world: 'MAIN'` in Manifest V3) and replaces or wraps `window.ethereum.request`. It intercepts `eth_accounts` and `eth_requestAccounts` to return a different address.

```javascript
// Simplified injection (content script with world: 'MAIN')
const real = window.ethereum.request.bind(window.ethereum);
window.ethereum.request = async (args) => {
    if (args.method === 'eth_accounts' || args.method === 'eth_requestAccounts') {
        return [SPOOFED_ADDRESS];
    }
    return real(args);
};
```

**What it can do:**
- Make the dApp UI display a different connected address
- Trick client-side balance checks (if the dApp reads balance of the "connected" address)
- Fool client-side portfolio views, NFT galleries, token lists
- Bypass client-side allowlists that check `if (connectedAddress in whitelist)`

**What it cannot do:**
- Alter `msg.sender` on-chain
- Sign messages or transactions as the spoofed address
- Pass `personal_sign` / `eth_sign` verification (ecrecover reveals real signer)
- Change contract state that is guarded by `msg.sender` checks

**Impact:** LOW for well-designed dApps. HIGH for dApps that trust `eth_accounts` as authentication without signature verification. This is the core educational finding of this project.

**Affected dApps (HYPOTHESIS -- to be tested):**
- dApps that gate content by address without SIWE (Sign-In with Ethereum)
- NFT viewing platforms that show "your NFTs" based on connected address
- Airdrop claim UIs that check eligibility client-side before sending the tx
- Governance UIs that display voting power based on connected address

**Not affected:**
- Any dApp using EIP-4361 (SIWE) for authentication
- On-chain access controls (`require(msg.sender == ...)`)
- Server-side signature verification

### A2. eth_call from-Field Manipulation

**Mechanism:** The `eth_call` JSON-RPC method accepts a `from` parameter that sets `msg.sender` during the simulated execution. Since `eth_call` is a local simulation (no signature, no state change), the node trusts whatever `from` is provided.

```javascript
// Simulate a call AS the owner, without being the owner
const result = await provider.call({
    from: '0x7a3E312Ec6e20a9F62fE2405938EB9060312E334', // owner address
    to: '0xE80ca47D14B56cce3AB0e7A993603CA6d52Bd8A8',   // SpoofChallenge
    data: iface.encodeFunctionData('checkCallerVsOwner')
});
// result will show callerIsOwner = true
```

**What it can do:**
- Make view functions return results as if you were any address
- Simulate what would happen if a specific address called a function
- Useful for legitimate purposes (e.g., Tenderly simulations, Etherscan "Read as" feature)

**What it cannot do:**
- Change any on-chain state
- "Prove" ownership or access
- Be submitted as an actual transaction

**Impact:** NONE for security. This is working as designed. The `eth_call` `from` parameter exists specifically for simulation purposes. Etherscan's "Read Contract" page lets anyone set the `from` address for exactly this reason.

**Important distinction:** If a dApp uses `eth_call` to check permissions and then enables UI features based on the result, the spoofed `eth_call` could fool the UI. But the actual transaction would still fail.

### A3. Fake Event/Log Injection via Malicious RPC

**Mechanism:** If a dApp uses an untrusted RPC endpoint to read events, the malicious RPC could return fabricated event logs. For example, it could claim that `SpoofClaimed(0xATTACKER, true)` was emitted when it never was.

```javascript
// A malicious RPC could return fake logs for eth_getLogs
// The dApp would then display "Spoof succeeded!" when it didn't
```

**What it can do:**
- Fool dApps into displaying incorrect event history
- Show fake transaction confirmations
- Display incorrect contract state

**What it cannot do:**
- Alter actual on-chain state
- Fool other nodes or other RPC endpoints
- Persist if the dApp switches to a trusted RPC

**Impact:** LOW-MEDIUM. Only relevant if the dApp blindly trusts a single RPC endpoint. Mitigated by using reputable RPCs (Alchemy, Infura, QuickNode) or running your own node. Relevant for this project only as a demonstration of the "layers of trust" concept.

---

## Category B: Protocol-Level Vectors

These vectors can genuinely cause a contract to see a different `msg.sender` than the EOA that initiated the transaction. However, they all require the contract to opt in to the pattern.

### B1. Meta-Transactions via EIP-2771 Trusted Forwarder

**Reference:** [EIP-2771](https://eips.ethereum.org/EIPS/eip-2771)

**Mechanism:** EIP-2771 defines a pattern where a "trusted forwarder" contract relays transactions on behalf of users. The target contract inherits from `ERC2771Context` and uses `_msgSender()` instead of `msg.sender`. When a call comes from the trusted forwarder, `_msgSender()` reads the original sender from the last 20 bytes of `calldata` (appended by the forwarder).

```solidity
// OpenZeppelin ERC2771Context (simplified)
function _msgSender() internal view virtual override returns (address sender) {
    if (msg.data.length >= 20 && isTrustedForwarder(msg.sender)) {
        // Read the appended sender address from calldata
        assembly {
            sender := shr(96, calldataload(sub(calldatasize(), 20)))
        }
    } else {
        return msg.sender;
    }
}
```

**Flow:**
```
User signs: {from: userAddr, to: targetContract, data: calldata}
Forwarder verifies signature, then calls:
    targetContract.someFunction(calldata ++ userAddr)
    where msg.sender = forwarderAddr
Target contract sees:
    msg.sender = forwarderAddr (the forwarder)
    _msgSender() = userAddr (extracted from calldata)
```

**Attack scenario:** If an attacker can call the target contract directly and append a fake address to the calldata, AND the target contract trusts the attacker's contract as a forwarder, then `_msgSender()` would return the fake address.

**Why this doesn't apply to SpoofChallenge:** Our contract uses `msg.sender` directly, not `_msgSender()`. It does not inherit from `ERC2771Context` and has no trusted forwarder list. The EIP-2771 vector requires the contract to explicitly opt in.

**Real-world relevance:** HIGH. Many DeFi protocols and NFT contracts use EIP-2771 for gasless transactions. If the trusted forwarder list is misconfigured (e.g., trusting a compromised or malicious forwarder), it could be exploited. OpenZeppelin's implementation has been audited, but custom implementations may have bugs.

**Known incidents:** The "arbitrary address spoofing" vulnerability in OpenZeppelin's `Multicall` + `ERC2771Context` interaction (2023). When `Multicall.multicall()` was called through a trusted forwarder, the appended sender address from the forwarder was only applied to the outer call, not the inner delegatecalls. This was patched in OpenZeppelin Contracts v4.9.3.

### B2. Account Abstraction via EIP-4337

**Reference:** [EIP-4337](https://eips.ethereum.org/EIPS/eip-4337)

**Mechanism:** EIP-4337 introduces "smart accounts" that are contracts (not EOAs). The flow is:

```
EOA (owner key) signs a UserOperation
  -> Bundler submits to EntryPoint contract
    -> EntryPoint calls smartAccount.validateUserOp(userOp)
    -> If valid, EntryPoint calls target via smartAccount.execute(...)
    -> target sees msg.sender = smartAccount address (NOT the EOA)
```

**What this means for spoofing:** The target contract sees `msg.sender = smartAccountAddress`, which is different from the EOA that signed the UserOperation. But this is by design -- the smart account IS the "identity" in EIP-4337.

**Attack scenario:** Could someone create a smart account that has the same address as an existing EOA? No. Contract addresses are derived from `CREATE` (deployer + nonce) or `CREATE2` (deployer + salt + bytecode hash). You cannot deploy a contract at an arbitrary pre-existing EOA address because:
1. `CREATE`: would need to control the deployer and predict the exact nonce
2. `CREATE2`: would need to find a salt that produces the target address (computationally equivalent to finding a private key -- ~2^160 work)

**Why this doesn't apply to SpoofChallenge:** The owner is an EOA (`0x7a3E...2334`). Even if an attacker created a smart account, its address would be different from the owner's address. `msg.sender == owner` would fail.

### B3. Proxy / Delegatecall Context Manipulation

**Mechanism:** When Contract A calls Contract B via `delegatecall`, the code of B executes in the context of A. This means `msg.sender` in B's code is the original caller of A, and `address(this)` is A's address.

```solidity
// Contract A (proxy)
fallback() external payable {
    (bool ok, ) = implementation.delegatecall(msg.data);
    require(ok);
}
// When user calls A.someFunction():
//   msg.sender in the delegatecall context = user (the original caller)
//   address(this) = A's address
```

**Attack scenario:** If SpoofChallenge were a proxy and an attacker could change the implementation to a malicious contract, the malicious implementation could manipulate storage directly (since delegatecall shares storage context). But this requires control of the proxy's admin, which is an entirely different attack.

**Why this doesn't apply to SpoofChallenge:** SpoofChallenge is not a proxy. It is a simple, non-upgradeable contract. There is no delegatecall.

---

## Category C: Infrastructure Attacks

These are theoretical attacks that would require compromising Ethereum's infrastructure itself.

### C1. Malicious RPC Endpoint

**Mechanism:** If a user connects to a malicious RPC endpoint, that endpoint could:
- Return fake `eth_call` results (making it look like `msg.sender == owner` succeeded)
- Return fake transaction receipts (making it look like a tx succeeded when it didn't)
- Refuse to broadcast real transactions
- Return fake block data

**What it cannot do:**
- Alter the actual state of the Ethereum blockchain
- Fool other nodes or other RPC endpoints
- Make a transaction with an invalid signature pass consensus validation

**Impact for this project:** If the test website uses a malicious RPC, the on-screen results could be faked. But querying the same contract via a different RPC (or Basescan) would reveal the truth. This is why we verify results against Basescan, not just the dApp's own RPC responses.

**Mitigation:** Use reputable RPC providers. For critical operations, cross-check against multiple independent sources. The SpoofChallenge contract can be read by anyone via Basescan.

### C2. Consensus-Level Attack (51% Attack)

**Mechanism:** If an attacker controls >50% of validators on a PoS chain (or >50% of hashrate on PoW), they could theoretically rewrite blocks to include transactions with forged signatures. But this would:
- Require billions of dollars of staked ETH (for Ethereum mainnet)
- Be detectable by any full node that validates signatures
- Break the fundamental security model of the chain

**For Base (L2):** Base is an optimistic rollup. The sequencer posts transaction data to Ethereum L1. If the sequencer includes a transaction with an invalid signature, the fraud proof mechanism would catch it during the challenge period. However, if the sequencer AND all challengers are compromised, it could theoretically pass.

**Impact:** THEORETICAL ONLY. Not a practical attack vector for this project or any realistic scenario.

### C3. Breaking ECDSA (secp256k1)

**Mechanism:** If someone found an efficient algorithm for the elliptic curve discrete logarithm problem (ECDLP) on secp256k1, they could derive any address's private key from its public key and sign transactions as that address.

**Current status:**
- Best known classical attack: Pollard's rho, O(sqrt(n)) = ~2^128 operations. Infeasible.
- Quantum: Shor's algorithm could break ECDSA, but requires ~2500 logical qubits for secp256k1. Current quantum computers have ~1000 noisy qubits, far from the ~millions of physical qubits needed. Not a near-term threat (estimated 10-20+ years).
- No known mathematical shortcut for secp256k1 specifically.

**Impact:** THEORETICAL ONLY. If ECDSA is broken, the entire Ethereum ecosystem (and most of the internet's TLS infrastructure) collapses. This is not specific to our project.

---

## Summary Matrix

| Vector | Alters UI? | Alters msg.sender? | Alters State? | Requires Private Key? | Requires Contract Opt-In? | Practical? |
|---|---|---|---|---|---|---|
| A1: Provider injection | YES | NO | NO | NO | NO | YES |
| A2: eth_call from-field | YES (simulation) | YES (simulation only) | NO | NO | NO | YES |
| A3: Fake RPC logs | YES | NO | NO | NO | NO | YES |
| B1: EIP-2771 forwarder | N/A | YES (_msgSender) | YES | NO (signer key) | YES | YES |
| B2: EIP-4337 AA | N/A | YES (smart account) | YES | YES (owner key) | YES | YES |
| B3: Delegatecall proxy | N/A | Context-dependent | YES | Depends | YES | YES |
| C1: Malicious RPC | YES | NO (real chain) | NO | NO | NO | LOW |
| C2: 51% attack | N/A | YES | YES | NO | NO | NO |
| C3: Break ECDSA | N/A | YES | YES | DERIVED | NO | NO |

## Conclusions for SpoofWallet

1. **The Chrome extension (A1) will successfully spoof the UI** but will fail to alter `msg.sender`. This is the expected result and the educational core of the project.

2. **The `eth_call` vector (A2) is worth demonstrating** because it shows a subtle nuance: view function simulations CAN be "spoofed" in the sense that you can simulate being any address. This is by design, not a bug.

3. **EIP-2771 (B1) is the most interesting "legitimate" vector** because it shows that contracts CAN be designed to accept a sender address from calldata rather than from `msg.sender`. But this requires the contract to opt in. SpoofChallenge does not.

4. **No vector can bypass `require(msg.sender == owner)` on SpoofChallenge** without possessing the owner's private key. This is the core finding.

## Recommended Test Matrix

For the SpoofWallet experiment, we should demonstrate:

| Test | Expected Result | Validates |
|---|---|---|
| Connect with spoof extension, read displayed address | Shows spoofed address | A1 works at UI layer |
| Sign message, ecrecover in browser | Returns REAL address, not spoofed | A1 fails at crypto layer |
| Call `checkCallerVsOwner()` via eth_call with spoofed from | Shows callerIsOwner = true | A2 works in simulation |
| Call `checkCallerVsOwner()` via eth_sendTransaction | Shows callerIsOwner = false | A1 fails on-chain |
| Call `claimSpoof()` via real tx | Reverts with "Not owner" | A1 fails for state changes |
| Call `callPublic()`, check event log | `caller` = real address | A1 fails in events |

## References

1. EIP-2771: Secure Protocol for Native Meta Transactions -- https://eips.ethereum.org/EIPS/eip-2771
2. EIP-4337: Account Abstraction Using Alt Mempool -- https://eips.ethereum.org/EIPS/eip-4337
3. EIP-1193: Ethereum Provider JavaScript API -- https://eips.ethereum.org/EIPS/eip-1193
4. EIP-4361: Sign-In with Ethereum -- https://eips.ethereum.org/EIPS/eip-4361
5. OpenZeppelin ERC2771Context + Multicall vulnerability disclosure (2023) -- https://github.com/OpenZeppelin/openzeppelin-contracts/security/advisories/GHSA-g4vp-m682-qqmp
6. Ethereum Yellow Paper, Appendix F -- https://ethereum.github.io/yellowpaper/paper.pdf
7. NIST Post-Quantum Cryptography standardization -- https://csrc.nist.gov/projects/post-quantum-cryptography
