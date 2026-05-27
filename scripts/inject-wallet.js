// This script reads the auditor private key and outputs the JS injection code
// to be pasted into Chrome console for wallet connection
const fs = require('fs');
const path = require('path');

function loadEnv(fp) {
  for (const l of fs.readFileSync(fp, 'utf8').split('\n')) {
    const t = l.trim(); if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('='); if (eq === -1) continue;
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[t.slice(0, eq).trim()] = v;
  }
}

loadEnv(path.join(process.env.USERPROFILE, '.claude', 'secrets', 'auditsuites101.env'));

const key = process.env.AUDITOR_WALLET_PRIVATE_KEY;
const { ethers } = require('ethers');
const wallet = new ethers.Wallet(key);

// Write injection script to a temp file that can be read by Chrome MCP
const injectionScript = `
// Inject EIP-1193 provider with auditor wallet
(function() {
  const CHAIN_ID = '0x2105'; // Base mainnet = 8453
  const ADDRESS = '${wallet.address.toLowerCase()}';
  const KEY = '${key}';

  // Minimal provider
  const provider = {
    isMetaMask: true,
    _events: {},
    on(event, fn) { (this._events[event] = this._events[event] || []).push(fn); return this; },
    removeListener() { return this; },
    removeAllListeners() { return this; },
    async request({ method, params }) {
      switch(method) {
        case 'eth_chainId': return CHAIN_ID;
        case 'net_version': return '8453';
        case 'eth_accounts':
        case 'eth_requestAccounts': return [ADDRESS];
        case 'wallet_switchEthereumChain': return null;
        case 'eth_getBalance':
          return fetch('https://mainnet.base.org', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_getBalance',params})}).then(r=>r.json()).then(r=>r.result);
        case 'eth_estimateGas':
        case 'eth_call':
        case 'eth_getTransactionCount':
        case 'eth_getCode':
        case 'eth_blockNumber':
        case 'eth_getBlockByNumber':
          return fetch('https://mainnet.base.org', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}).then(r=>r.json()).then(r=>r.result);
        case 'eth_sendTransaction': {
          // Sign and send
          const tx = params[0];
          const resp = await fetch('https://mainnet.base.org', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_getTransactionCount',params:[ADDRESS,'latest']})});
          const nonce = (await resp.json()).result;

          const { ethers } = await import('https://cdnjs.cloudflare.com/ajax/libs/ethers/6.13.4/ethers.min.js');
          const w = new ethers.Wallet(KEY, new ethers.JsonRpcProvider('https://mainnet.base.org'));
          const signed = await w.signTransaction({...tx, nonce, chainId: 8453});

          const sendResp = await fetch('https://mainnet.base.org', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_sendRawTransaction',params:[signed]})});
          return (await sendResp.json()).result;
        }
        case 'personal_sign':
        case 'eth_signTypedData_v4':
          console.log('[InjectedWallet] Sign request:', method, params);
          return '0x'; // TODO: implement signing
        default:
          console.log('[InjectedWallet] Unhandled:', method, params);
          return null;
      }
    }
  };

  Object.defineProperty(window, 'ethereum', { get: () => provider, configurable: true });
  window.dispatchEvent(new Event('ethereum#initialized'));
  console.log('[InjectedWallet] Provider injected for', ADDRESS);
})();
`;

// Write to temp file
const tempPath = path.join(process.env.TEMP || '/tmp', 'wallet-inject.js');
fs.writeFileSync(tempPath, injectionScript);
console.log('Injection script written to:', tempPath);
console.log('Wallet address:', wallet.address);
