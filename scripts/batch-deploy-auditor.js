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

loadEnv(path.join(process.env.USERPROFILE, '.claude', 'secrets', 'auditsuites101.env'));
loadEnv(path.join(process.env.USERPROFILE, '.claude', 'secrets', 'engine.env'));

const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
const wallet = new ethers.Wallet(process.env.AUDITOR_WALLET_PRIVATE_KEY, provider);
const FACTORY = '0xE85A59c628F7d27878ACeB4bf3b35733630083a9';

const raw = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'research', 'factory_abi.json'), 'utf8'));
const factoryAbi = JSON.parse(raw.result);

// Template configs from proven deploys
let thryxTemplate, burnoutTemplate;

const TOKENS = [
  { name: '#MemorialDay2026', symbol: 'REMEMBER', img: 'https://images.unsplash.com/photo-1569340335529-2e232e1b1ae5?w=400&h=400&fit=crop', meta: '{"description":"Honoring those who served. Freedom is not free. #MemorialDay #USA #NeverForget #Honor #crypto","socialMediaUrls":[],"auditUrls":[]}', template: 'thryxusd' },
  { name: 'Eid Mubarak', symbol: 'EID', img: 'https://images.unsplash.com/photo-1564769625905-50e93615e769?w=400&h=400&fit=crop', meta: '{"description":"Eid Mubarak! Celebrating prosperity and blessings on-chain. #EidMubarak #Eid2026 #Blessed #crypto #Base","socialMediaUrls":[],"auditUrls":[]}', template: 'burnout' },
  { name: 'Based AI', symbol: 'BASEDAI', img: 'https://images.unsplash.com/photo-1677442136019-21780ecad995?w=400&h=400&fit=crop', meta: '{"description":"The most based AI agent on Base. Autonomous. Unstoppable. #BasedAI #AI #Base #Agent #crypto","socialMediaUrls":["https://x.com/BasedAIToken"],"auditUrls":[]}', template: 'burnout' },
  { name: '#StopTheScams', symbol: 'SAFE', img: 'https://images.unsplash.com/photo-1563013544-824ae1b704d3?w=400&h=400&fit=crop', meta: '{"description":"Protecting crypto users from scams. Security first. Every trade funds anti-scam education. #StopTheScams #CryptoSafe #Security","socialMediaUrls":[],"auditUrls":[]}', template: 'thryxusd' },
  { name: 'World Peace', symbol: 'PEACE', img: 'https://images.unsplash.com/photo-1541354329998-f4d9a9f9297f?w=400&h=400&fit=crop', meta: '{"description":"One world. One token. Peace on-chain. #WorldPeace #Peace #Unity #Base #crypto","socialMediaUrls":[],"auditUrls":[]}', template: 'burnout' },
];

async function loadTemplates() {
  const p2 = new ethers.JsonRpcProvider('https://gateway.tenderly.co/public/base');
  const iface = new ethers.Interface(factoryAbi);

  // THRYXUSD template (USDC pair, static hook)
  const thryxTx = await p2.getTransaction('0x29cac2072c00abf17b9ac24f7526225d1b90692d71a9c28497ce403cb9797a20');
  thryxTemplate = iface.parseTransaction({ data: thryxTx.data, value: thryxTx.value }).args[0];

  // Burnout template (WETH pair, dynamic hook)
  const burnoutTx = await p2.getTransaction('0x275e354d95b6f0faab0f8c5eec41bf154ebb303d16fc2f22e7b0baa961476f2b');
  burnoutTemplate = iface.parseTransaction({ data: burnoutTx.data, value: burnoutTx.value }).args[0];

  console.log('Templates loaded');
}

async function deploy(token) {
  const tmpl = token.template === 'thryxusd' ? thryxTemplate : burnoutTemplate;
  const salt = ethers.keccak256(ethers.toUtf8Bytes(token.symbol + '-' + Date.now()));

  const config = {
    tokenConfig: {
      tokenAdmin: wallet.address,
      name: token.name,
      symbol: token.symbol,
      salt,
      image: token.img,
      metadata: token.meta,
      context: tmpl.tokenConfig.context || '{"interface":"clanker.world","platform":"","messageId":"","id":""}',
      originatingChainId: 8453,
    },
    poolConfig: {
      hook: tmpl.poolConfig.hook,
      pairedToken: tmpl.poolConfig.pairedToken,
      tickIfToken0IsClanker: tmpl.poolConfig.tickIfToken0IsClanker,
      tickSpacing: tmpl.poolConfig.tickSpacing,
      poolData: tmpl.poolConfig.poolData,
    },
    lockerConfig: {
      locker: tmpl.lockerConfig.locker,
      rewardAdmins: [wallet.address],
      rewardRecipients: [wallet.address],
      rewardBps: [10000],
      tickLower: [...tmpl.lockerConfig.tickLower],
      tickUpper: [...tmpl.lockerConfig.tickUpper],
      positionBps: [...tmpl.lockerConfig.positionBps],
      lockerData: tmpl.lockerConfig.lockerData,
    },
    mevModuleConfig: {
      mevModule: tmpl.mevModuleConfig.mevModule,
      mevModuleData: tmpl.mevModuleConfig.mevModuleData || '0x',
    },
    extensionConfigs: [],
  };

  const factory = new ethers.Contract(FACTORY, factoryAbi, wallet);
  const tx = await factory.deployToken(config);
  const receipt = await tx.wait();

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() === FACTORY.toLowerCase() &&
        log.topics[0] === '0x9299d1d1a88d8e1abdc591ae7a167a6bc63a8f17d695804e9091ee33aa89fb67') {
      return ethers.getAddress('0x' + log.topics[1].slice(26));
    }
  }
  return null;
}

async function main() {
  console.log('Timestamp:', new Date().toISOString());
  console.log('Wallet:', wallet.address);
  console.log('ETH:', ethers.formatEther(await provider.getBalance(wallet.address)));
  console.log('');

  await loadTemplates();

  const deployed = [];
  for (const token of TOKENS) {
    try {
      console.log('Deploying', token.symbol, '(' + token.name + ')...');
      const addr = await deploy(token);
      if (addr) {
        deployed.push({ ...token, address: addr });
        console.log('  DEPLOYED:', addr);
      }
      await new Promise(r => setTimeout(r, 3000));
    } catch (e) {
      console.log('  FAILED:', e.reason || e.message?.slice(0, 80));
    }
  }

  console.log('');
  console.log('=== DEPLOYED', deployed.length, '/', TOKENS.length, '===');
  for (const d of deployed) {
    console.log(d.symbol, d.address, 'https://clanker.world/clanker/' + d.address);
  }
  console.log('ETH remaining:', ethers.formatEther(await provider.getBalance(wallet.address)));
}

main().catch(e => { console.error(e.message?.slice(0, 200)); process.exit(1); });
