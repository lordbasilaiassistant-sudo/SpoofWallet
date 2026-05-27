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
const p = new ethers.JsonRpcProvider('https://mainnet.base.org');

const FACTORY = '0xE85A59c628F7d27878ACeB4bf3b35733630083a9';
const FL = '0xF3622742b1E446D92e45E22923Ef11C2fcD55D68';
const WETH = '0x4200000000000000000000000000000000000006';

async function main() {
  console.log('=== SCANNING FOR HIGH-FEE TOKENS ===');
  console.log('Timestamp:', new Date().toISOString());
  console.log('');

  // Get recent TokenCreated events from factory to find active tokens
  const currentBlock = await p.getBlockNumber();
  const TOKEN_CREATED_TOPIC = ethers.id('TokenCreated(address,uint256,address,uint256,string,string,uint256,address,string)');

  // Scan last 50k blocks (~28 hours) for token launches
  const fromBlock = currentBlock - 50000;
  console.log('Scanning blocks', fromBlock, 'to', currentBlock, '...');

  let logs;
  try {
    logs = await p.getLogs({
      address: FACTORY,
      topics: [TOKEN_CREATED_TOPIC],
      fromBlock,
      toBlock: currentBlock,
    });
    console.log('Found', logs.length, 'token launches in last ~28 hours');
  } catch (e) {
    // If range too big, split
    console.log('Range too big, trying last 10k blocks...');
    logs = await p.getLogs({
      address: FACTORY,
      topics: [TOKEN_CREATED_TOPIC],
      fromBlock: currentBlock - 10000,
      toBlock: currentBlock,
    });
    console.log('Found', logs.length, 'token launches in last ~5.5 hours');
  }

  if (logs.length === 0) {
    console.log('No recent launches found');
    return;
  }

  // Decode token addresses from logs (first indexed param is tokenAddress)
  const tokens = logs.map(log => {
    // tokenAddress is the first indexed param (topic[1])
    return '0x' + log.topics[1].slice(26);
  }).filter((v, i, a) => a.indexOf(v) === i); // dedupe

  console.log('Unique tokens:', tokens.length);
  console.log('');

  // Check uncollected fees for each token's deployer
  const fl = new ethers.Contract(FL, ['function availableFees(address,address) view returns (uint256)'], p);
  const factoryAbi = ['function tokenDeploymentInfo(address) view returns (address,address,address,address[])'];
  const factory = new ethers.Contract(FACTORY, factoryAbi, p);
  const tokenAbi = ['function admin() view returns (address)'];

  const profitable = [];
  let checked = 0;

  for (const token of tokens.slice(0, 50)) { // check first 50
    try {
      const tokenContract = new ethers.Contract(token, tokenAbi, p);
      const admin = await tokenContract.admin();

      const fees = await fl.availableFees(admin, WETH);
      checked++;

      if (fees > ethers.parseEther('0.001')) { // > 0.001 WETH
        profitable.push({ token, admin, fees: ethers.formatEther(fees) });
        console.log('FOUND:', token.slice(0, 10) + '..', 'admin:', admin.slice(0, 10) + '..', 'WETH fees:', ethers.formatEther(fees));
      }
    } catch (e) {
      // Skip failed reads
    }

    // Rate limit
    if (checked % 10 === 0) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  console.log('');
  console.log('Checked', checked, 'tokens');
  console.log('Profitable (>0.001 WETH):', profitable.length);
  console.log('');

  if (profitable.length > 0) {
    console.log('=== TOP TARGETS ===');
    profitable.sort((a, b) => parseFloat(b.fees) - parseFloat(a.fees));
    for (const t of profitable.slice(0, 10)) {
      console.log('  Token:', t.token);
      console.log('  Admin:', t.admin);
      console.log('  WETH:', t.fees);
      console.log('');
    }
  }
}

main().catch(e => console.error(e.message));
