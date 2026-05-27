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

// Use AUDITOR wallet
loadEnv(path.join(process.env.USERPROFILE, '.claude', 'secrets', 'auditsuites101.env'));
loadEnv(path.join(process.env.USERPROFILE, '.claude', 'secrets', 'engine.env'));

const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
const wallet = new ethers.Wallet(process.env.AUDITOR_WALLET_PRIVATE_KEY, provider);

const FACTORY = '0xE85A59c628F7d27878ACeB4bf3b35733630083a9';

async function main() {
  console.log('Timestamp:', new Date().toISOString());
  console.log('Wallet:', wallet.address);
  console.log('ETH:', ethers.formatEther(await provider.getBalance(wallet.address)));

  // Clone THRYXUSD's exact deploy params from its tx
  const thryxTx = await provider.getTransaction('0x29cac2072c00abf17b9ac24f7526225d1b90692d71a9c28497ce403cb9797a20');
  const raw = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'research', 'factory_abi.json'), 'utf8'));
  const abi = JSON.parse(raw.result);
  const iface = new ethers.Interface(abi);
  const oc = iface.parseTransaction({ data: thryxTx.data, value: thryxTx.value }).args[0];

  const salt = ethers.keccak256(ethers.toUtf8Bytes('auditor-deploy-' + Date.now()));

  const config = {
    tokenConfig: {
      tokenAdmin: wallet.address,
      name: '#SaveTheOcean',
      symbol: 'OCEAN',
      salt,
      image: 'https://images.unsplash.com/photo-1518837695005-2083093ee35b?w=400&h=400&fit=crop&q=80',
      metadata: '{"description":"Every trade saves the ocean. 100% of creator fees fund ocean cleanup. #SaveTheOcean #OceanConservation #ClimateAction #Base #DeFiForGood","socialMediaUrls":["https://x.com/SaveOceanCoin"],"auditUrls":[]}',
      context: oc.tokenConfig.context || '{"interface":"clanker.world","platform":"","messageId":"","id":""}',
      originatingChainId: 8453,
    },
    poolConfig: {
      hook: oc.poolConfig.hook,  // Same hook as THRYXUSD (static fee)
      pairedToken: oc.poolConfig.pairedToken,  // USDC pair like THRYXUSD
      tickIfToken0IsClanker: oc.poolConfig.tickIfToken0IsClanker,
      tickSpacing: oc.poolConfig.tickSpacing,
      poolData: oc.poolConfig.poolData,  // Same pool data
    },
    lockerConfig: {
      locker: oc.lockerConfig.locker,
      rewardAdmins: [wallet.address],
      rewardRecipients: [wallet.address],
      rewardBps: [10000],  // 100% of fees to us
      tickLower: [...oc.lockerConfig.tickLower],  // Same tick range
      tickUpper: [...oc.lockerConfig.tickUpper],
      positionBps: [...oc.lockerConfig.positionBps],  // 1 position like THRYXUSD
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
  console.log('Deploying #SaveTheOcean (OCEAN)...');
  console.log('  Hook:', config.poolConfig.hook.slice(0,14), '(same as THRYXUSD)');
  console.log('  Paired with USDC (same as THRYXUSD)');
  console.log('  1 position (same as THRYXUSD)');
  console.log('  Image: YES');
  console.log('');

  // Simulate first
  try {
    const result = await factory.deployToken.staticCall(config);
    console.log('Simulation SUCCESS! Token:', result);
  } catch (e) {
    console.log('Simulation FAILED:', e.reason || e.message?.slice(0, 150));
    return;
  }

  // Deploy
  const tx = await factory.deployToken(config);
  console.log('TX:', tx.hash);
  const receipt = await tx.wait();
  console.log('Gas:', receipt.gasUsed.toString());

  // Find token address from events
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() === FACTORY.toLowerCase() &&
        log.topics[0] === '0x9299d1d1a88d8e1abdc591ae7a167a6bc63a8f17d695804e9091ee33aa89fb67') {
      const addr = ethers.getAddress('0x' + log.topics[1].slice(26));
      console.log('');
      console.log('*** OCEAN DEPLOYED:', addr, '***');
      console.log('Clanker:', 'https://clanker.world/clanker/' + addr);
      console.log('Basescan:', 'https://basescan.org/token/' + addr);
    }
  }

  console.log('ETH remaining:', ethers.formatEther(await provider.getBalance(wallet.address)));
}

main().catch(e => { console.error(e.reason || e.message?.slice(0, 200)); process.exit(1); });
