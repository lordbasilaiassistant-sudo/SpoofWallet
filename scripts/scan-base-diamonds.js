const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const SECRETS_PATH = path.join(process.env.USERPROFILE, '.claude', 'secrets', 'engine.env');

function loadEnv(filepath) {
  const content = fs.readFileSync(filepath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
    process.env[key] = val;
  }
}

loadEnv(SECRETS_PATH);

const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
const API_KEY = process.env.BASESCAN_API_KEY;

async function fetchVerifiedContracts(page) {
  const url = `https://api.etherscan.io/v2/api?chainid=8453&module=contract&action=getcontractcreation&contractaddresses=&apikey=${API_KEY}`;
  // Use verified contracts list instead
  const listUrl = `https://api.etherscan.io/v2/api?chainid=8453&module=contract&action=listcontracts&page=${page}&offset=20&apikey=${API_KEY}`;
  const resp = await fetch(listUrl);
  const data = await resp.json();
  return data.result || [];
}

async function checkIfDiamond(address) {
  try {
    // Check for diamondCut selector (0x204dbd34 is not standard — check for facetAddresses/facets)
    // Standard Diamond Loupe: facets() = 0x7a0ed627, facetAddresses() = 0x52ef6b2c
    const facetAddrSelector = '0x52ef6b2c';
    const facetsSelector = '0x7a0ed627';

    let isDiamond = false;

    try {
      const result = await provider.call({ to: address, data: facetAddrSelector });
      if (result && result !== '0x' && result.length > 10) isDiamond = true;
    } catch {}

    if (!isDiamond) {
      try {
        const result = await provider.call({ to: address, data: facetsSelector });
        if (result && result !== '0x' && result.length > 10) isDiamond = true;
      } catch {}
    }

    return isDiamond;
  } catch {
    return false;
  }
}

async function checkOwner(address) {
  // Try common owner() selectors
  const ownerSelector = '0x8da5cb5b'; // owner()
  try {
    const result = await provider.call({ to: address, data: ownerSelector });
    if (result && result.length === 66) {
      const owner = '0x' + result.slice(26);
      // Check if owner is EOA (no code)
      const code = await provider.getCode(owner);
      const isEOA = code === '0x';
      return { owner, isEOA };
    }
  } catch {}
  return null;
}

async function checkDelegation(address) {
  // Check if an EOA has EIP-7702 delegation (code starts with 0xef0100)
  try {
    const code = await provider.getCode(address);
    if (code && code.startsWith('0xef0100')) {
      const delegateTo = '0x' + code.slice(8, 48);
      return { delegated: true, delegateTo };
    }
    return { delegated: false };
  } catch {
    return { delegated: false };
  }
}

async function scanKnownDiamonds() {
  // Known Diamond proxies on Base to check
  const knownDiamonds = [
    // Our own
    { addr: '0x0D5d767Dfad78a81237bCa60d986d68bffE9B174', name: 'SpoofWallet Diamond' },
    // Well-known Diamond/proxy patterns on Base — check a sample
  ];

  // Also try to find Diamonds by checking recently verified contracts
  console.log('=== Scanning for Diamond proxies on Base ===\n');

  // First check our own Diamond
  for (const d of knownDiamonds) {
    const isDiamond = await checkIfDiamond(d.addr);
    const ownerInfo = await checkOwner(d.addr);
    console.log(`${d.name} (${d.addr})`);
    console.log(`  Diamond Loupe: ${isDiamond ? 'YES' : 'NO (custom Diamond without Loupe)'}`);
    if (ownerInfo) {
      console.log(`  Owner: ${ownerInfo.owner}`);
      console.log(`  Owner is EOA: ${ownerInfo.isEOA}`);
      if (ownerInfo.isEOA) {
        const delegation = await checkDelegation(ownerInfo.owner);
        console.log(`  Owner has EIP-7702 delegation: ${delegation.delegated}`);
        if (delegation.delegated) {
          console.log(`  *** ACTIVE DELEGATION to ${delegation.delegateTo} ***`);
        }
        console.log(`  RISK: EOA owner on EIP-7702-enabled chain = vulnerable to delegation phishing`);
      }
    }
    console.log();
  }

  // Scan for contracts with owner() that are EOAs on Base
  // This broader scan checks if known protocol addresses have EOA owners
  const protocolContracts = [
    { addr: '0x2626664c2603336E57B271c5C0b26F421741e481', name: 'Uniswap V3 Router (Base)' },
    { addr: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD', name: 'Uniswap V3 Factory (Base)' },
    { addr: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da', name: 'Aerodrome Router' },
    { addr: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', name: 'Aerodrome Voter' },
    { addr: '0xe85a59c628f7d27878aceb4bf3b35733630083a9', name: 'Clanker V3 Factory' },
  ];

  console.log('=== Checking known Base protocols for EOA owners ===\n');

  for (const p of protocolContracts) {
    const ownerInfo = await checkOwner(p.addr);
    const isDiamond = await checkIfDiamond(p.addr);
    console.log(`${p.name} (${p.addr})`);
    console.log(`  Diamond: ${isDiamond}`);
    if (ownerInfo) {
      console.log(`  Owner: ${ownerInfo.owner}`);
      console.log(`  Owner is EOA: ${ownerInfo.isEOA}`);
      if (ownerInfo.isEOA) {
        const delegation = await checkDelegation(ownerInfo.owner);
        console.log(`  7702 delegation active: ${delegation.delegated}`);
        if (delegation.delegated) {
          console.log(`  *** WARNING: ACTIVE DELEGATION — protocol at risk ***`);
        }
      }
    } else {
      console.log(`  No owner() function`);
    }
    console.log();
  }
}

scanKnownDiamonds().catch(err => { console.error(err); process.exit(1); });
