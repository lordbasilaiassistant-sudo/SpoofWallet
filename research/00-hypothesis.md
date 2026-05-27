# 00 -- Core Hypothesis

## Key Takeaway

Browser-level wallet spoofing (overriding `window.ethereum`) can trick dApp UIs into displaying a fake address, but **cannot** forge `msg.sender` on-chain. The Ethereum protocol derives `msg.sender` from the transaction's ECDSA signature via `ecrecover`, which requires the target address's private key -- something a browser extension categorically does not have. This makes `require(msg.sender == owner)` guards cryptographically secure against provider-injection attacks.

---

## Hypothesis (Falsifiable)

> **H0 (Null):** A Chrome extension that intercepts `window.ethereum.request({method: 'eth_accounts'})` and returns a spoofed address CANNOT cause `msg.sender` in a Solidity contract to equal the spoofed address. The on-chain `msg.sender` will always be the address corresponding to the private key that actually signed the transaction.

> **H1 (Alternative):** There exists a mechanism by which overriding the browser-level Ethereum provider causes `msg.sender` to differ from the actual signer's address.

**Prediction under H0:** When a user with wallet A uses the spoof extension to impersonate wallet B, then calls `SpoofChallenge.checkCallerVsOwner()`:
- `caller` will return wallet A (the real signer)
- `contractOwner` will return `0x7a3E...2334` (the deployer)
- `callerIsOwner` will return `false` (unless A == deployer)
- `SpoofChallenge.claimSpoof()` will revert with "Not owner" because `msg.sender != owner`

**What would falsify H0:** If `msg.sender` on-chain ever equals the spoofed address (wallet B) when wallet A signed the transaction, H0 is false and there is a critical security vulnerability in the Ethereum protocol or the RPC/node implementation.

## Methodology

### Phase 1: Protocol Analysis (Papers 01-02)
Document from first principles how Ethereum derives `msg.sender`. Enumerate all theoretical attack vectors that could cause `msg.sender` to differ from the actual signer.

### Phase 2: Extension Testing
1. Install the SpoofWallet Chrome extension
2. Connect real wallet (address A) to the test website
3. Configure extension to spoof address B (the deployer: `0x7a3E312Ec6e20a9F62fE2405938EB9060312E334`)
4. Observe: does the dApp UI show address B? (Expected: YES -- this is the trivial, known vulnerability)
5. Sign a message and verify via `ecrecover` client-side. Does recovered address == A or B? (Expected: A)
6. Call `SpoofChallenge.callPublic()` and check the `PublicCalled` event's `caller` field. (Expected: A)
7. Call `SpoofChallenge.claimSpoof()` -- does it revert or succeed? (Expected: revert)

### Phase 3: Exotic Vectors (Paper 02)
Test whether any of the following can bypass `msg.sender`:
- Meta-transactions (ERC-2771 / GSN)
- Malicious RPC endpoint returning forged tx data
- EIP-4337 account abstraction with bundled UserOperations
- Relay patterns where a trusted forwarder contract is `msg.sender`

### Phase 4: Write-Up
Document all results, positive and negative, with tx hashes for on-chain evidence.

## Scope Boundaries

**In scope:**
- Browser provider injection (`window.ethereum` override)
- Client-side address spoofing (what the dApp UI sees)
- On-chain `msg.sender` verification
- Signature verification (`ecrecover` / `personal_sign`)
- Meta-transaction and relayer patterns
- Account abstraction (EIP-4337)

**Out of scope:**
- Private key theft / compromise (if you have the key, you ARE the wallet)
- Smart contract bugs unrelated to `msg.sender` (reentrancy, overflow, etc.)
- Social engineering attacks
- DNS hijacking of RPC endpoints (network-level attack, not browser-level)

## Test Infrastructure

### SpoofChallenge Contract
- **Address:** `0xE80ca47D14B56cce3AB0e7A993603CA6d52Bd8A8`
- **Network:** Base mainnet (chain ID 8453)
- **Owner:** `0x7a3E312Ec6e20a9F62fE2405938EB9060312E334`
- **Deploy tx:** `0x48dc715fb30e1bb8cb965236f3c15b8c62067c5d16aaff54d35813c4f047e9c4`
- **Source:** `contracts/SpoofChallenge.sol`

Key functions for testing:
- `checkCallerVsOwner()` -- view function, returns `(msg.sender, owner, msg.sender == owner)`
- `claimSpoof()` -- state-changing, requires `msg.sender == owner`, sets `spoofSucceeded = true`
- `callPublic()` -- no access control, emits `PublicCalled(msg.sender, count)`

### SpoofTest Contract (simpler variant)
- **Address:** `0x7b2e8eE2b88D3Ff8dfB792a8fE4c9CbfD7cc3F4E`
- **Source:** `contracts/SpoofTest.sol`

## Expected Outcome

With high confidence (>99.9%), H0 will hold. The Ethereum protocol's use of ECDSA signatures for sender authentication is not vulnerable to browser-level provider injection. The extension will successfully fool the dApp UI but will fail completely at the protocol level.

The educational value is in demonstrating this gap clearly: **what the UI shows you is not what the blockchain enforces.**

## Related Work

- EIP-1193: Ethereum Provider JavaScript API -- defines `window.ethereum` interface
- EIP-4361: Sign-In with Ethereum (SIWE) -- signature-based auth that defeats provider spoofing
- EIP-2771: Secure Protocol for Native Meta Transactions -- trusted forwarder pattern
- EIP-4337: Account Abstraction Using Alt Mempool -- changes who can initiate transactions
- Ethereum Yellow Paper, Appendix F: Signing Transactions (ECDSA parameter recovery)
