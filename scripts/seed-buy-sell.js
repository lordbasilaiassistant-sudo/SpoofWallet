// Seed buyer — buys a tiny amount of our tokens then sells back
// Uses Universal Router V2 for V4 swaps
// This creates a trade record on the pool, triggering DEX indexers

const { ethers } = require('ethers');
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

loadEnv(path.join(process.env.USERPROFILE, '.claude', 'secrets', 'engine.env'));
const provider = new ethers.JsonRpcProvider('https://base-rpc.publicnode.com');
const wallet = new ethers.Wallet(process.env.THRYXTREASURY_PRIVATE_KEY, provider);

const WETH = '0x4200000000000000000000000000000000000006';
const UNIVERSAL_ROUTER = '0x6fF5693b99212Da76ad316178A184AB56D299b43';
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

// V4 swap via Universal Router uses:
// Command 0x10 = V4_SWAP
// The actions encoding follows the V4 router format

// Actually, the simplest approach: use the PoolManager.unlock callback directly
// Our SandwichAttacker already does V4 swaps. Let's use a simpler version.

// For seed buying, the absolute simplest: send ETH to the pool via the
// Universal Router's WRAP_ETH + V4_SWAP commands

async function main() {
  console.log('Timestamp:', new Date().toISOString());
  console.log('Wallet:', wallet.address);

  const weth = new ethers.Contract(WETH, [
    'function balanceOf(address) view returns (uint256)',
    'function deposit() payable',
    'function approve(address,uint256) returns (bool)',
  ], wallet);

  const wethBal = await weth.balanceOf(wallet.address);
  console.log('WETH:', ethers.formatEther(wethBal));

  // The UR V4 swap encoding is complex. Let me try the simplest possible approach:
  // Use the PoolManager.unlock directly from our existing SandwichAttacker contract

  const FLASH_SANDWICH = '0x37340AB4Bb5aaF033A7Aa038C8B8c0ab21d1074D';

  // Check if FlashSandwich can do a simple swap (buy only, no sandwich)
  // Actually it can't — it's designed for flash loan + double swap

  // The REAL simplest approach: deploy a minimal V4 SwapHelper contract
  // OR: just use cast send with the PoolManager directly

  console.log('');
  console.log('To seed buy/sell on V4 pools, need either:');
  console.log('1. Deploy a SwapHelper contract (costs gas)');
  console.log('2. Use cast send with PoolManager.unlock');
  console.log('3. Use the Clanker frontend (needs wallet connection)');
  console.log('');
  console.log('Let me try using forge script to do the swap on a fork first...');
}

main();
