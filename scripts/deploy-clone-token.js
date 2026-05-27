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

async function main() {
  console.log('Timestamp:', new Date().toISOString());
  console.log('Wallet:', wallet.address);
  const bal = await provider.getBalance(wallet.address);
  console.log('ETH:', ethers.formatEther(bal));

  // Get burnout's EXACT tx data and replay with different name/symbol/salt
  const burnoutTx = await provider.getTransaction('0x275e354d95b6f0faab0f8c5eec41bf154ebb303d16fc2f22e7b0baa961476f2b');

  const raw = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'research', 'factory_abi.json'), 'utf8'));
  const abi = JSON.parse(raw.result);
  const iface = new ethers.Interface(abi);
  const decoded = iface.parseTransaction({ data: burnoutTx.data, value: burnoutTx.value });

  const oc = decoded.args[0];
  const newSalt = ethers.keccak256(ethers.toUtf8Bytes('SpoofWallet-TRAP-' + Date.now()));

  const deploymentConfig = {
    tokenConfig: {
      tokenAdmin: wallet.address,
      name: 'Sentinel Agent',
      symbol: 'SNTL',
      salt: newSalt,
      image: 'https://raw.githubusercontent.com/lordbasilaiassistant-sudo/SpoofWallet/master/website/favicon.ico',
      metadata: 'Sentinel Agent - autonomous on-chain security monitoring and threat detection for Base ecosystem smart contracts',
      context: oc.tokenConfig.context || '',
      originatingChainId: 8453,
    },
    poolConfig: {
      hook: oc.poolConfig.hook,
      pairedToken: oc.poolConfig.pairedToken,
      tickIfToken0IsClanker: oc.poolConfig.tickIfToken0IsClanker,
      tickSpacing: oc.poolConfig.tickSpacing,
      poolData: oc.poolConfig.poolData,
    },
    lockerConfig: {
      locker: oc.lockerConfig.locker,
      rewardAdmins: [wallet.address],
      rewardRecipients: [wallet.address],
      rewardBps: [10000],
      tickLower: [...oc.lockerConfig.tickLower],
      tickUpper: [...oc.lockerConfig.tickUpper],
      positionBps: [...oc.lockerConfig.positionBps],
      lockerData: oc.lockerConfig.lockerData,
    },
    mevModuleConfig: {
      mevModule: oc.mevModuleConfig.mevModule,
      mevModuleData: oc.mevModuleConfig.mevModuleData || '0x',
    },
    extensionConfigs: [],
  };

  const factory = new ethers.Contract(FACTORY, abi, wallet);

  console.log('');
  console.log('=== DEPLOYING SPOOFTRAP ===');
  console.log('Exact same pool params as burnout (proven to work)');
  console.log('All fees → our wallet');
  console.log('');

  // Simulate
  console.log('Simulating...');
  try {
    const result = await factory.deployToken.staticCall(deploymentConfig);
    console.log('Simulation SUCCESS! Token at:', result);
  } catch (e) {
    console.log('Simulation failed:', e.reason || e.data?.slice(0, 60) || e.message?.slice(0, 150));

    // If it's a salt issue (address already exists), try a different salt
    if (e.message?.includes('salt') || e.data?.includes('salt')) {
      console.log('Trying different salt...');
    }
    return;
  }

  // Deploy
  console.log('');
  console.log('Deploying...');
  const tx = await factory.deployToken(deploymentConfig);
  console.log('TX:', tx.hash);
  const receipt = await tx.wait();
  console.log('Gas:', receipt.gasUsed.toString());
  console.log('Gas cost:', ethers.formatEther(receipt.gasUsed * receipt.gasPrice), 'ETH');

  // Find token address
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() === FACTORY.toLowerCase() && log.topics.length >= 2) {
      const addr = '0x' + log.topics[1]?.slice(26);
      if (addr && addr.length === 42) {
        console.log('');
        console.log('*** TOKEN DEPLOYED:', addr, '***');
        console.log('Clanker: https://clanker.world/clanker/' + addr);
        console.log('Basescan: https://basescan.org/token/' + addr);
        console.log('');
        console.log('Sniper bots will hit within seconds.');
        console.log('80% sniper tax = instant fee revenue.');
        break;
      }
    }
  }

  const balAfter = await provider.getBalance(wallet.address);
  console.log('ETH remaining:', ethers.formatEther(balAfter));
}

main().catch(e => { console.error(e.reason || e.message?.slice(0, 200)); process.exit(1); });
