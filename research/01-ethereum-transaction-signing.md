# 01 -- Ethereum Transaction Signing: Why msg.sender Cannot Be Spoofed

## Key Takeaway

`msg.sender` in Solidity is **not** a field that the transaction sender chooses. It is **derived** by the EVM from the transaction's ECDSA signature using `ecrecover`. The only way to make `msg.sender` equal a target address is to possess the target's private key. No amount of browser-level, provider-level, or RPC-level manipulation can change this -- the math is enforced by every validating node in the network.

---

## 1. Transaction Structure

An Ethereum transaction (post-EIP-1559, type 2) contains these fields:

```
Transaction {
    chainId:              uint256
    nonce:                uint256
    maxPriorityFeePerGas: uint256
    maxFeePerGas:         uint256
    gasLimit:             uint256
    to:                   address (20 bytes) or empty for contract creation
    value:                uint256
    data:                 bytes (calldata)
    accessList:           [(address, [storageKey])]
    v:                    uint8 (recovery id, 0 or 1)
    r:                    uint256 (ECDSA signature component)
    s:                    uint256 (ECDSA signature component)
}
```

**Critical observation:** There is no `from` field in the signed transaction payload. The sender address is not explicitly included in the transaction data that gets broadcast to the network.

Reference: [EIP-1559](https://eips.ethereum.org/EIPS/eip-1559), [EIP-2718](https://eips.ethereum.org/EIPS/eip-2718) (typed transaction envelope).

## 2. How the Sender Is Determined

### Step 1: Transaction Serialization

The transaction fields (without v, r, s) are RLP-encoded into a byte string:

```
unsigned_tx = RLP([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas,
                   gasLimit, to, value, data, accessList])
```

For type-2 transactions, this is prepended with the type byte `0x02`:

```
signing_payload = 0x02 || RLP([chainId, nonce, ...])
```

### Step 2: Hashing

The signing payload is hashed with Keccak-256:

```
txHash = keccak256(signing_payload)
```

### Step 3: ECDSA Signing (Client-Side)

The wallet (MetaMask, hardware wallet, etc.) signs `txHash` with the user's private key:

```
(v, r, s) = ecdsaSign(txHash, privateKey)
```

This produces the signature components `v`, `r`, `s` which are appended to the transaction.

### Step 4: Public Key Recovery (Node-Side)

When a node receives the signed transaction, it performs `ecrecover`:

```
publicKey = ecrecover(txHash, v, r, s)
sender = keccak256(publicKey)[12:]   // last 20 bytes = Ethereum address
```

This is defined in the Ethereum Yellow Paper, Appendix F (equation 384):

> S(T) = B_{96..255}(KEC(ECDSARECOVER(h(T), v, r, s)))

Where:
- `h(T)` is the hash of the unsigned transaction
- `ECDSARECOVER` returns the 64-byte public key
- `KEC` is Keccak-256
- `B_{96..255}` extracts bytes 12-31 (the last 20 bytes, i.e., the Ethereum address)

### Step 5: msg.sender Assignment

The EVM sets `msg.sender` to this recovered address. There is no other input. The node does NOT read a `from` field from the transaction -- it computes the sender purely from the signature.

## 3. The Cryptographic Guarantee

The security of this mechanism rests on the **ECDSA discrete logarithm problem**:

Given a target address `T` (which implies a target public key `P_T`), to produce a valid signature `(v, r, s)` such that `ecrecover(txHash, v, r, s)` returns `P_T`, you must know the private key `k` where `P_T = k * G` (G = generator point on secp256k1).

**There is no known way to produce a valid ECDSA signature for a public key without knowing the corresponding private key.** This is the elliptic curve discrete logarithm problem (ECDLP), which is believed to be computationally infeasible for 256-bit curves.

Concretely: to make `msg.sender` equal `0x7a3E312Ec6e20a9F62fE2405938EB9060312E334` (the SpoofChallenge owner), you must possess the private key for that address. Period.

## 4. What the Browser Extension Actually Controls

When a Chrome extension overrides `window.ethereum`, it operates at the **JavaScript provider layer** -- far above the protocol layer:

```
[Layer Diagram]

Layer 4: dApp UI (reads eth_accounts, displays address)      <-- SPOOFABLE
Layer 3: window.ethereum provider (JavaScript API, EIP-1193)  <-- SPOOFABLE
Layer 2: Wallet (MetaMask) signing engine                     <-- NOT SPOOFABLE*
Layer 1: RPC node (validates & broadcasts tx)                 <-- NOT SPOOFABLE
Layer 0: EVM execution (ecrecover -> msg.sender)              <-- NOT SPOOFABLE

* Unless the wallet itself is compromised (private key theft)
```

The extension can intercept and modify responses at Layers 3-4:

```javascript
// What the extension does:
const originalRequest = window.ethereum.request.bind(window.ethereum);
window.ethereum.request = async function(args) {
    if (args.method === 'eth_accounts' || args.method === 'eth_requestAccounts') {
        // Return spoofed address instead of real one
        return ['0xSPOOFED_ADDRESS'];
    }
    // All other calls (including eth_sendTransaction) pass through
    return originalRequest(args);
};
```

But when the dApp calls `eth_sendTransaction`, the request passes through to MetaMask's signing engine. MetaMask:
1. Constructs the unsigned transaction
2. Signs it with the REAL private key
3. Broadcasts the signed transaction to the network

The extension CANNOT intercept the signing step because MetaMask's signing engine runs in a separate extension context (its own service worker and isolated world), not in the page's JavaScript context.

## 5. The eth_sendTransaction Flow in Detail

Here is exactly what happens when a dApp sends a transaction:

```
dApp calls: window.ethereum.request({
    method: 'eth_sendTransaction',
    params: [{
        from: '0xSPOOFED',     // <-- dApp thinks this is the sender
        to: '0xContract',
        data: '0x...',
        value: '0x0'
    }]
})

Step 1: Extension intercepts? Maybe, but it must forward to MetaMask
        eventually -- the extension cannot sign transactions.

Step 2: MetaMask receives the request.
        It sees `from: 0xSPOOFED`.
        MetaMask checks: do I have the private key for 0xSPOOFED?
        
        Case A: No -> MetaMask throws an error.
                "The requested account and/or method has not been authorized."
                Transaction never gets signed or broadcast.
        
        Case B: The extension doesn't modify eth_sendTransaction's `from` field,
                so MetaMask sees the real address and signs normally.
                msg.sender on-chain = real address, not spoofed.

Step 3: If the transaction IS signed and broadcast:
        The node runs ecrecover and gets the REAL signer's address.
        msg.sender = real signer. Always.
```

**Key insight:** Even if the extension modifies the `from` field in `eth_sendTransaction` params, MetaMask will either:
- Reject the transaction (unknown account), or
- Ignore the `from` field and sign with whatever account is selected in MetaMask

The `from` field in `eth_sendTransaction` is a **hint** to the wallet about which account to use. It is NOT included in the signed transaction payload (see Section 1). The wallet can ignore it, and the node definitely ignores it -- the node derives the sender from the signature.

## 6. What About `eth_call` (Read-Only)?

There is a subtle distinction for read-only calls (`eth_call`, used for view functions):

```javascript
// eth_call does accept a `from` parameter
await provider.call({
    from: '0xSPOOFED',      // This IS used by the node
    to: contractAddress,
    data: encodedCalldata
});
```

For `eth_call`, the `from` field IS used by the node to set `msg.sender` during the simulated execution. This is because `eth_call` does not require a signature -- it is a local simulation, not a real transaction.

**This means:** A spoofed `eth_call` with `from: ownerAddress` WOULD show `callerIsOwner = true` in `checkCallerVsOwner()`. But this is meaningless because:
1. No state change occurs (it is a simulation)
2. No transaction is broadcast
3. The contract's storage is unchanged
4. `claimSpoof()` would still revert in an actual transaction

This is worth testing explicitly to demonstrate the difference between `eth_call` (simulation) and `eth_sendTransaction` (real).

## 7. Code Example: Verifying the Guarantee

```javascript
const { ethers } = require('ethers');

// Demonstrate that msg.sender = ecrecover result
async function demonstrateSenderDerivation() {
    // Create a random wallet (we know the private key)
    const wallet = ethers.Wallet.createRandom();
    console.log('Address:', wallet.address);
    console.log('Private key:', wallet.privateKey);
    
    // Create an unsigned transaction
    const tx = {
        chainId: 8453,
        nonce: 0,
        maxPriorityFeePerGas: ethers.parseUnits('0.001', 'gwei'),
        maxFeePerGas: ethers.parseUnits('0.1', 'gwei'),
        gasLimit: 21000,
        to: '0x0000000000000000000000000000000000000001',
        value: 0,
        data: '0x'
    };
    
    // Sign it
    const signedTx = await wallet.signTransaction(tx);
    
    // Parse the signed transaction to recover the sender
    const parsed = ethers.Transaction.from(signedTx);
    console.log('Recovered from:', parsed.from);
    console.log('Match:', parsed.from === wallet.address); // Always true
}
```

## 8. Edge Cases and Caveats

### 8a. Contract Wallets (EIP-4337)

With account abstraction, the "signer" and the "account" can be different. A UserOperation is signed by an EOA (the "owner" of the smart account), but the actual `msg.sender` at the target contract is the smart account address, not the EOA.

However, this does NOT help with spoofing because:
- The smart account validates the signature internally via `validateUserOp`
- The EntryPoint contract enforces this validation
- You still need the smart account owner's private key

### 8b. CREATE2 / Counterfactual Addresses

A contract deployed via CREATE2 has a deterministic address. You cannot spoof `msg.sender` using CREATE2 because the deployed contract's address becomes `msg.sender` only when that contract makes an external call -- and you would need to deploy your own contract at the target address, which requires knowing the exact bytecode + salt + deployer combination.

### 8c. Trusted Forwarders (EIP-2771)

Contracts that implement EIP-2771 use `_msgSender()` instead of `msg.sender`, which reads the original sender from the last 20 bytes of `msg.data` when the call comes from a trusted forwarder. This is a DESIGNED mechanism for meta-transactions, not a vulnerability -- but it does mean `_msgSender() != msg.sender` by design. See Paper 02 for analysis.

## 9. Summary Table

| Layer | Can Extension Spoof? | Why / Why Not |
|---|---|---|
| dApp UI (displayed address) | YES | Extension controls `window.ethereum` responses |
| `eth_accounts` response | YES | Extension intercepts EIP-1193 requests |
| `personal_sign` recovered address | NO | Signature uses real private key; `ecrecover` returns real address |
| `eth_sendTransaction` `from` param | PARTIALLY | Can modify the hint, but wallet will reject or ignore |
| On-chain `msg.sender` | NO | Derived from ECDSA signature by every node; requires private key |
| `eth_call` simulated `msg.sender` | YES | `from` param is used in simulation (no signature required) |
| Contract state changes | NO | Requires real transaction with valid signature |

## References

1. Ethereum Yellow Paper, Appendix F: Signing Transactions -- https://ethereum.github.io/yellowpaper/paper.pdf
2. EIP-155: Simple Replay Attack Protection -- https://eips.ethereum.org/EIPS/eip-155
3. EIP-1559: Fee Market Change -- https://eips.ethereum.org/EIPS/eip-1559
4. EIP-2718: Typed Transaction Envelope -- https://eips.ethereum.org/EIPS/eip-2718
5. EIP-1193: Ethereum Provider JavaScript API -- https://eips.ethereum.org/EIPS/eip-1193
6. SEC-P 256k1 curve parameters -- https://www.secg.org/sec2-v2.pdf
7. NIST Digital Signature Standard (ECDSA) -- FIPS 186-4
