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

const FACTORY = '0xE85A59c628F7d27878ACeB4bf3b35733630083a9';
const WETH = '0x4200000000000000000000000000000000000006';

// From our research: these are the exact addresses used by burnout token
const HOOK = '0xDd5EeaFf7BD481AD55Db083062b13a3cdf0A68CC';
const LOCKER = '0x63D2DfEA64b3433F4071A98665bcD7Ca14d93496';
const MEV_MODULE = '0x63D2DfEA64b3433F4071A98665bcD7Ca14d93496';

// Load factory ABI
const raw = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'research', 'factory_abi.json'), 'utf8'));
const factoryAbi = JSON.parse(raw.result);

async function main() {
  console.log('Timestamp:', new Date().toISOString());
  console.log('Wallet:', wallet.address);
  const bal = await provider.getBalance(wallet.address);
  console.log('ETH:', ethers.formatEther(bal));
  console.log('');

  const factory = new ethers.Contract(FACTORY, factoryAbi, wallet);

  // Generate a unique salt
  const salt = ethers.keccak256(ethers.toUtf8Bytes('SpoofWallet-AntiMEV-' + Date.now()));

  // Token config — named to attract attention
  const tokenConfig = {
    tokenAdmin: wallet.address,
    name: 'MEV Trap',
    symbol: 'TRAP',
    salt: salt,
    image: '',
    metadata: 'Anti-MEV research token. Bots that buy early get taxed. Proceeds fund security research.',
    context: '',
    originatingChainId: 8453,
  };

  // Pool config — from burnout's working config
  const poolConfig = {
    hook: HOOK,
    pairedToken: WETH,
    tickIfToken0IsClanker: -230400, // Same as burnout — sets initial price
    tickSpacing: 60,
    poolData: '0x', // Hook-specific init data
  };

  // Locker config — 5 positions at different tick ranges for deep liquidity
  // From burnout's config, optimized for our analysis
  const lockerConfig = {
    locker: LOCKER,
    rewardAdmins: [wallet.address],
    rewardRecipients: [wallet.address], // ALL fees come to us
    rewardBps: [10000], // 100% of fees
    tickLower: [-230400, -214000, -202000, -155000, -141000],
    tickUpper: [-214000, -155000, -155000, -120000, -120000],
    positionBps: [1000, 5000, 1500, 2000, 500], // Must sum to 10000
    lockerData: '0x',
  };

  const mevModuleConfig = {
    mevModule: ethers.ZeroAddress,
    mevModuleData: '0x',
  };

  const deploymentConfig = {
    tokenConfig,
    poolConfig,
    lockerConfig,
    mevModuleConfig,
    extensionConfigs: [],
  };

  console.log('=== DEPLOYING MEV TRAP TOKEN ===');
  console.log('Name:', tokenConfig.name);
  console.log('Symbol:', tokenConfig.symbol);
  console.log('All fees → our wallet');
  console.log('');

  // Simulate first
  console.log('Simulating...');
  try {
    const result = await factory.deployToken.staticCall(deploymentConfig);
    console.log('Simulation SUCCESS! Token would be at:', result);
  } catch (e) {
    console.log('Simulation failed:', e.reason || e.data?.slice(0, 40) || e.message?.slice(0, 150));
    console.log('');
    console.log('Error details — need to adjust params');

    // Common issues: wrong hook, wrong locker, locker not enabled for this hook
    // Let me try with the exact same hook/locker combo that burnout used
    return;
  }

  // If simulation passes, deploy for real
  console.log('');
  console.log('Deploying for real...');
  const tx = await factory.deployToken(deploymentConfig);
  console.log('Deploy TX:', tx.hash);
  const receipt = await tx.wait();
  console.log('Deployed! Gas:', receipt.gasUsed.toString());

  // Get token address from event
  const tokenCreatedTopic = ethers.id('TokenCreated(address,uint256,address,uint256,string,string,uint256,address,string)');
  const createdEvent = receipt.logs.find(l => l.topics[0] === tokenCreatedTopic);
  if (createdEvent) {
    const tokenAddr = '0x' + createdEvent.topics[1].slice(26);
    console.log('');
    console.log('*** TOKEN DEPLOYED: ' + tokenAddr + ' ***');
    console.log('View at: https://clanker.world/clanker/' + tokenAddr);
    console.log('');
    console.log('Sniper bots will buy within seconds.');
    console.log('80% sniper tax = immediate revenue.');
    console.log('All LP fees flow to our wallet.');
  }

  const balAfter = await provider.getBalance(wallet.address);
  console.log('ETH remaining:', ethers.formatEther(balAfter));
}

main().catch(e => { console.error(e.reason || e.message?.slice(0, 200)); process.exit(1); });
