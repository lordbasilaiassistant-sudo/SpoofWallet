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
const raw = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'research', 'factory_abi.json'), 'utf8'));
const factoryAbi = JSON.parse(raw.result);

const TOKENS = [
  {
    name: 'Eid Mubarak',
    symbol: 'EID',
    metadata: 'Eid Mubarak! Celebrating prosperity and blessings on-chain. https://eidmubarak.xyz #EidMubarak #Eid2026 #Blessed #crypto #base',
    image: 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/05/Eid_Mubarak_Calligraphy.svg/1200px-Eid_Mubarak_Calligraphy.svg.png',
  },
  {
    name: 'Memorial Day',
    symbol: 'MEMORIAL',
    metadata: 'In honor of those who served. Freedom isn\'t free. https://memorialday.us #MemorialDay #USA #Freedom #NeverForget #base',
    image: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a4/Flag_of_the_United_States.svg/1200px-Flag_of_the_United_States.svg.png',
  },
  {
    name: 'Arsenal FC',
    symbol: 'GUNNERS',
    metadata: 'The Gunners are taking the league. North London is red. https://arsenal.com #Arsenal #COYG #PremierLeague #Gunners #football',
    image: 'https://upload.wikimedia.org/wikipedia/en/thumb/5/53/Arsenal_FC.svg/800px-Arsenal_FC.svg.png',
  },
  {
    name: 'FOMO',
    symbol: 'FOMO',
    metadata: 'You are already late. The fear of missing out drives everything. https://fomo.finance #FOMO #crypto #base #memecoin #LFG',
    image: 'https://i.imgur.com/YQjKzVr.png',
  },
  {
    name: 'COPIUM',
    symbol: 'COPIUM',
    metadata: 'Pure concentrated copium. Inhale deeply. Everything will be fine. https://copium.lol #copium #cope #crypto #meme #base',
    image: 'https://i.kym-cdn.com/entries/icons/original/000/035/699/pepe.jpg',
  },
];

async function deploy(token) {
  const burnoutTx = await provider.getTransaction('0x275e354d95b6f0faab0f8c5eec41bf154ebb303d16fc2f22e7b0baa961476f2b');
  const iface = new ethers.Interface(factoryAbi);
  const decoded = iface.parseTransaction({ data: burnoutTx.data, value: burnoutTx.value });
  const oc = decoded.args[0];

  const salt = ethers.keccak256(ethers.toUtf8Bytes(token.symbol + '-' + Date.now()));

  const config = {
    tokenConfig: {
      tokenAdmin: wallet.address,
      name: token.name,
      symbol: token.symbol,
      salt,
      image: token.image,
      metadata: token.metadata,
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

  const factory = new ethers.Contract(FACTORY, factoryAbi, wallet);
  const tx = await factory.deployToken(config);
  const receipt = await tx.wait();

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() === FACTORY.toLowerCase()) {
      const addr = '0x' + log.topics[1]?.slice(26);
      if (addr && addr.length === 42 && log.topics[0] === '0x9299d1d1a88d8e1abdc591ae7a167a6bc63a8f17d695804e9091ee33aa89fb67') {
        return addr;
      }
    }
  }
  return null;
}

async function main() {
  console.log('Timestamp:', new Date().toISOString());
  console.log('ETH:', ethers.formatEther(await provider.getBalance(wallet.address)));
  console.log('');
  console.log('Deploying 5 trending-topic tokens...');
  console.log('');

  const deployed = [];

  for (const token of TOKENS) {
    try {
      console.log('Deploying ' + token.symbol + ' (' + token.name + ')...');
      const addr = await deploy(token);
      if (addr) {
        deployed.push({ ...token, address: addr });
        console.log('  DEPLOYED: ' + addr);
        console.log('  https://clanker.world/clanker/' + addr);
      }
      await new Promise(r => setTimeout(r, 5000));
    } catch (e) {
      console.log('  FAILED: ' + (e.reason || e.message?.slice(0, 80)));
    }
  }

  console.log('');
  console.log('=== DEPLOYED ' + deployed.length + '/' + TOKENS.length + ' ===');
  for (const d of deployed) {
    console.log(d.symbol + ': ' + d.address);
  }
  console.log('');
  console.log('ETH remaining:', ethers.formatEther(await provider.getBalance(wallet.address)));

  // Save to file
  fs.writeFileSync(
    path.resolve(__dirname, '..', 'deployed-trending.json'),
    JSON.stringify(deployed, null, 2)
  );
}

main().catch(e => { console.error(e.reason || e.message?.slice(0, 200)); process.exit(1); });
