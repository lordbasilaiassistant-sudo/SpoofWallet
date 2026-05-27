# Spoof Wallet

Chrome extension + test website for simulating wallet identity during transactions. Connect any wallet, then choose a different wallet address (one that actually performed a specific on-chain transaction) to present as your identity to the test page.

**Educational and testing purposes only.** This tool exists to help developers and security researchers understand how dApps verify wallet identity and where those checks can fail.

## How It Works

1. **Install the Chrome extension** from this repo
2. **Visit the test website** (hosted on GitHub Pages)
3. **Connect your real wallet** (MetaMask, etc.)
4. **Pick a target wallet** — enter any address that executed a real on-chain transaction
5. **The extension intercepts** `window.ethereum` calls and presents the spoofed address to the test page
6. **The test page shows** what the dApp "sees" vs. your actual connected wallet, demonstrating the gap

## Architecture

```
chrome-extension/       # Manifest V3 Chrome extension
  ├── manifest.json     # Extension config
  ├── content.js        # Injects spoofed ethereum provider
  ├── background.js     # Service worker for extension state
  └── popup/            # Extension popup UI (select target wallet)

website/                # GitHub Pages test site
  ├── index.html        # Connect wallet + display identity page
  ├── app.js            # Web3 integration, shows real vs spoofed
  └── style.css
```

## Test Website

The GitHub Pages site at `https://lordbasilaiassistant-sudo.github.io/SpoofWallet/` serves as the **only** test target. The extension is configured to work exclusively with this page. It:

- Prompts wallet connection via standard EIP-1193 provider
- Displays the address the dApp receives (spoofed or real)
- Lets you pick a wallet that performed a specific transaction to impersonate
- Shows side-by-side comparison: what the dApp sees vs. what's actually signing

## Setup

### Extension (local dev)
```
1. Clone this repo
2. Open chrome://extensions
3. Enable "Developer mode"
4. Click "Load unpacked" → select the chrome-extension/ folder
```

### Website (GitHub Pages)
```
Deployed automatically from the website/ directory on push to main.
```

## What This Demonstrates

- **Provider injection is trust-based.** dApps trust `window.ethereum` to return the real signer address. A content script can override this trivially.
- **Address != authentication.** Displaying a wallet address is not proof of ownership. Only a valid signature from the private key proves control.
- **Signature verification matters.** dApps that verify signatures server-side (Sign-In with Ethereum / EIP-4361) are immune to this spoof. Those that only check `eth_accounts` are not.

## Limitations

- Cannot sign transactions as the spoofed wallet (no private key access)
- Cannot pass signature challenges (EIP-4361 / SIWE)
- Only works on the included test website — not a general-purpose attack tool
- Read-only impersonation of the address, nothing more

## Disclaimer

This project is for **educational and security research purposes only**. It demonstrates a known limitation in how dApps handle wallet identity. Do not use this to deceive, defraud, or impersonate others on production applications. The authors are not responsible for misuse.

## License

MIT
