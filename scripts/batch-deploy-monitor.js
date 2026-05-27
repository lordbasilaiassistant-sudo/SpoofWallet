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
const FL = '0xF3622742b1E446D92e45E22923Ef11C2fcD55D68';
const WETH = '0x4200000000000000000000000000000000000006';
const OUR_WALLET = wallet.address;

const raw = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'research', 'factory_abi.json'), 'utf8'));
const factoryAbi = JSON.parse(raw.result);

// All our deployed tokens
const DEPLOYED = [
  '0xE0A048281bF0dA1A24F360e6a3129959FdAA8b07', // burnout
  '0x2101B5feBa17C92391096f3e14978bEE16d93217', // SpoofTrap
  '0x89D2615a20Be4e94612b98a0B6a9e3816d99c513', // Aether Protocol
  '0x2c271c277F223A38d1da31d6FE68d9BeB7620b38', // Sentinel Agent
];

async function monitorAll() {
  console.log('=== MONITORING ALL TOKENS ===');
  console.log('Timestamp:', new Date().toISOString());
  console.log('');

  const fl = new ethers.Contract(FL, ['function availableFees(address,address) view returns (uint256)'], provider);
  const block = await provider.getBlockNumber();

  let totalWethFees = 0n;

  for (const token of DEPLOYED) {
    try {
      const tokenContract = new ethers.Contract(token, [
        'function name() view returns (string)',
        'function symbol() view returns (string)',
      ], provider);

      const [name, symbol] = await Promise.all([
        tokenContract.name(),
        tokenContract.symbol(),
      ]);

      // Check transfers
      const transferTopic = ethers.id('Transfer(address,address,uint256)');
      const logs = await provider.getLogs({
        address: token,
        topics: [transferTopic],
        fromBlock: block - 500,
        toBlock: block,
      });

      // Check fees
      const wethFees = await fl.availableFees(OUR_WALLET, WETH);
      totalWethFees = wethFees; // This is cumulative across all tokens

      const tokenFees = await fl.availableFees(OUR_WALLET, token);

      console.log(`${name} (${symbol}) — ${token.slice(0, 10)}..`);
      console.log(`  Transfers (last 500 blocks): ${logs.length}`);
      console.log(`  Token fees claimable: ${ethers.formatEther(tokenFees)}`);
      console.log('');

      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      console.log(`${token.slice(0, 10)}.. — error: ${e.message?.slice(0, 50)}`);
    }
  }

  console.log('Total WETH fees claimable:', ethers.formatEther(totalWethFees));
  console.log('ETH balance:', ethers.formatEther(await provider.getBalance(OUR_WALLET)));
  console.log('');

  if (totalWethFees > 0n) {
    console.log('*** FEES AVAILABLE — claiming... ***');
    const flWrite = new ethers.Contract(FL, ['function claim(address,address)'], wallet);
    const tx = await flWrite.claim(OUR_WALLET, WETH);
    console.log('Claim TX:', tx.hash);
    await tx.wait();
    console.log('CLAIMED!');
  }
}

async function deployToken(name, symbol, metadata) {
  const burnoutTx = await provider.getTransaction('0x275e354d95b6f0faab0f8c5eec41bf154ebb303d16fc2f22e7b0baa961476f2b');
  const iface = new ethers.Interface(factoryAbi);
  const decoded = iface.parseTransaction({ data: burnoutTx.data, value: burnoutTx.value });
  const oc = decoded.args[0];

  const newSalt = ethers.keccak256(ethers.toUtf8Bytes(name + '-' + Date.now()));

  const config = {
    tokenConfig: {
      tokenAdmin: wallet.address,
      name,
      symbol,
      salt: newSalt,
      image: '',
      metadata,
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
  console.log(`Deploying ${name} (${symbol})... TX: ${tx.hash}`);
  const receipt = await tx.wait();

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() === FACTORY.toLowerCase() && log.topics.length >= 2) {
      const addr = '0x' + log.topics[1]?.slice(26);
      if (addr && addr.length === 42) {
        DEPLOYED.push(addr);
        console.log(`*** ${name} DEPLOYED: ${addr} ***`);
        return addr;
      }
    }
  }
}

async function main() {
  const mode = process.argv[2] || 'monitor';

  if (mode === 'deploy') {
    const tokens = [
      ['Nexus AI', 'NEXAI', 'Autonomous AI agent framework for on-chain analytics and security monitoring'],
      ['Cortex Network', 'CRTX', 'Decentralized compute network for AI model inference on Base'],
      ['Onchain Oracle', 'ORACLE', 'Real-time on-chain data aggregation and price feed oracle for DeFi protocols'],
    ];

    for (const [name, symbol, meta] of tokens) {
      try {
        await deployToken(name, symbol, meta);
        await new Promise(r => setTimeout(r, 8000)); // wait between deploys
      } catch (e) {
        console.log(`Deploy failed for ${name}:`, e.reason || e.message?.slice(0, 80));
      }
    }
  }

  await monitorAll();
}

main().catch(e => console.error(e.message?.slice(0, 200)));
