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

const provider = new ethers.JsonRpcProvider('https://base-rpc.publicnode.com');
const wallet = new ethers.Wallet(process.env.AUDITOR_WALLET_PRIVATE_KEY, provider);
const FACTORY = '0xE85A59c628F7d27878ACeB4bf3b35733630083a9';
const raw = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'research', 'factory_abi.json'), 'utf8'));
const factoryAbi = JSON.parse(raw.result);

async function main() {
  console.log('Timestamp:', new Date().toISOString());
  console.log('Mining for B07 address suffix...');

  // Load MCPLT template (proven config)
  const p2 = new ethers.JsonRpcProvider('https://gateway.tenderly.co/public/base');
  const iface = new ethers.Interface(factoryAbi);
  // Use burnout template (always available)
  const burnoutTx = await p2.getTransaction('0x275e354d95b6f0faab0f8c5eec41bf154ebb303d16fc2f22e7b0baa961476f2b');
  const mcplt = iface.parseTransaction({ data: burnoutTx.data, value: burnoutTx.value }).args[0];
  console.log('Template loaded');

  const factory = new ethers.Contract(FACTORY, factoryAbi, wallet);
  let attempts = 0;
  let found = false;

  while (!found && attempts < 5000) {
    const salt = ethers.keccak256(ethers.toUtf8Bytes('B07-mine-' + Date.now() + '-' + attempts + '-' + Math.random()));

    const config = {
      tokenConfig: {
        tokenAdmin: wallet.address,
        name: 'NexaVault MCP',
        symbol: 'NXVLT',
        salt,
        image: 'https://images.unsplash.com/photo-1639762681485-074b7f938ba0?w=400&h=400&fit=crop&q=80',
        metadata: '{"description":"AI-powered vault optimization across Base DeFi. Your yield, maximized. Built on MCP. https://nexavault.xyz","socialMediaUrls":["https://x.com/NexaVaultMCP","https://t.me/NexaVaultMCP"]}',
        context: mcplt.tokenConfig.context || '{"interface":"clanker.world"}',
        originatingChainId: 8453,
      },
      poolConfig: {
        hook: mcplt.poolConfig.hook,
        pairedToken: mcplt.poolConfig.pairedToken,
        tickIfToken0IsClanker: mcplt.poolConfig.tickIfToken0IsClanker,
        tickSpacing: mcplt.poolConfig.tickSpacing,
        poolData: mcplt.poolConfig.poolData,
      },
      lockerConfig: {
        locker: mcplt.lockerConfig.locker,
        rewardAdmins: [wallet.address], rewardRecipients: [wallet.address], rewardBps: [10000],
        tickLower: [...mcplt.lockerConfig.tickLower], tickUpper: [...mcplt.lockerConfig.tickUpper],
        positionBps: [...mcplt.lockerConfig.positionBps], lockerData: mcplt.lockerConfig.lockerData,
      },
      mevModuleConfig: { mevModule: mcplt.mevModuleConfig.mevModule, mevModuleData: mcplt.mevModuleConfig.mevModuleData || '0x' },
      extensionConfigs: [],
    };

    try {
      const result = await factory.deployToken.staticCall(config);
      const addr = result.toLowerCase();

      if (addr.endsWith('b07') || addr.endsWith('B07')) {
        console.log('');
        console.log('*** FOUND B07 ADDRESS:', result, 'after', attempts + 1, 'attempts ***');
        console.log('Salt:', salt);

        // Deploy it for real
        console.log('Deploying...');
        const tx = await factory.deployToken(config);
        const receipt = await tx.wait();
        for (const log of receipt.logs) {
          if (log.address.toLowerCase() === FACTORY.toLowerCase() && log.topics[0] === MCPLT_TOPIC) {
            const deployedAddr = ethers.getAddress('0x' + log.topics[1].slice(26));
            console.log('DEPLOYED:', deployedAddr);
            console.log('https://clanker.world/clanker/' + deployedAddr);
          }
        }
        found = true;
      } else {
        if (attempts % 50 === 0) console.log('Attempt', attempts, '- got', addr.slice(-4), '(need b07)');
      }
    } catch (e) {
      // Skip simulation errors
    }

    attempts++;
  }

  if (!found) console.log('Did not find B07 in', attempts, 'attempts. Need more tries or different approach.');
  console.log('ETH remaining:', ethers.formatEther(await provider.getBalance(wallet.address)));
}

main().catch(e => { console.error(e.message?.slice(0, 200)); process.exit(1); });
