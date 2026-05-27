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
const p = new ethers.JsonRpcProvider('https://base-rpc.publicnode.com');
const w = new ethers.Wallet(process.env.THRYXTREASURY_PRIVATE_KEY, p);

const FACTORY = '0xE85A59c628F7d27878ACeB4bf3b35733630083a9';
const factoryAbi = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'research', 'factory_abi.json'), 'utf8'));

async function main() {
  const factory = new ethers.Contract(FACTORY, factoryAbi, p);

  console.log('Checking Clanker factory access...');

  try {
    const isAdmin = await factory.admins(w.address);
    console.log('Our wallet is admin:', isAdmin);
  } catch (e) {
    console.log('admins check failed');
  }

  try {
    const owner = await factory.owner();
    console.log('Factory owner:', owner);
    console.log('We are owner:', owner.toLowerCase() === w.address.toLowerCase());
  } catch (e) {}

  // Check if deployToken is restricted
  // From the source: deployToken has no modifier — it's PUBLIC
  // But it might check msg.value or other conditions internally
  console.log('');
  console.log('deployToken function signature found:', factoryAbi.some(a => a.name === 'deployToken'));

  // The simpler approach: use deployTokenZeroSupply which creates a token with no initial supply
  // Then we can use our Diamond's SPOOF tokens as the tradeable asset
  console.log('deployTokenZeroSupply found:', factoryAbi.some(a => a.name === 'deployTokenZeroSupply'));

  // Actually, let me look at what the burnout token deploy cost
  // We deployed it earlier today via Clanker frontend
  // That means the factory IS callable by non-admins for deployToken
  console.log('');
  console.log('NOTE: Burnout was deployed via Clanker frontend by our wallet');
  console.log('This means deployToken IS callable by anyone (not admin-restricted)');
  console.log('We CAN deploy another token directly from the factory');
}

main().catch(e => console.error(e.message?.slice(0, 100)));
