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
const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
const wallet = new ethers.Wallet(process.env.THRYXTREASURY_PRIVATE_KEY, provider);

const artifact = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '..', 'artifacts', 'mev-bot', 'FlashSandwich.json'), 'utf8'
));

const WETH = '0x4200000000000000000000000000000000000006';
const BURNOUT = '0xE0A048281bF0dA1A24F360e6a3129959FdAA8b07';
const BURNOUT_LOCKER = '0x63D2DfEA64b3433F4071A98665bcD7Ca14d93496';
const HOOK = '0xDd5EeaFf7BD481AD55Db083062b13a3cdf0A68CC';

async function main() {
  console.log('Timestamp:', new Date().toISOString());
  console.log('Deployer:', wallet.address);
  const bal = await provider.getBalance(wallet.address);
  console.log('ETH:', ethers.formatEther(bal));
  console.log('');

  // Step 1: Deploy
  console.log('=== DEPLOYING FlashSandwich ===');
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
  const contract = await factory.deploy();
  console.log('Deploy TX:', contract.deploymentTransaction().hash);
  await contract.waitForDeployment();
  const addr = await contract.getAddress();
  console.log('Deployed at:', addr);

  const balAfter = await provider.getBalance(wallet.address);
  console.log('ETH after deploy:', ethers.formatEther(balAfter));
  console.log('Deploy cost:', ethers.formatEther(bal - balAfter), 'ETH');
  console.log('');

  // Step 2: Simulate execute with eth_call
  // Need to construct PoolKey for burnout
  // currency0 must be < currency1
  const c0 = BURNOUT.toLowerCase() < WETH.toLowerCase() ? BURNOUT : WETH;
  const c1 = BURNOUT.toLowerCase() < WETH.toLowerCase() ? WETH : BURNOUT;

  console.log('=== SIMULATING sandwich on burnout token ===');
  console.log('currency0:', c0);
  console.log('currency1:', c1);

  // Try with a small flash loan amount first (0.01 WETH)
  const flashAmount = ethers.parseEther('0.01');

  const params = {
    token: BURNOUT,
    locker: BURNOUT_LOCKER,
    flashAmount: flashAmount,
    poolKey: {
      currency0: c0,
      currency1: c1,
      fee: 0x800000, // dynamic fee flag for V4 hooks
      tickSpacing: 60,
      hooks: HOOK,
    }
  };

  const iface = new ethers.Interface(artifact.abi);
  const calldata = iface.encodeFunctionData('execute', [params]);

  console.log('Flash amount:', ethers.formatEther(flashAmount), 'WETH');
  console.log('Simulating...');

  try {
    const result = await provider.call({
      to: addr,
      from: wallet.address,
      data: calldata,
    });
    console.log('*** SIMULATION SUCCESS ***');
    console.log('Result:', result);

    // Check if profitable before real execution
    const wethContract = new ethers.Contract(WETH, ['function balanceOf(address) view returns (uint256)'], provider);
    console.log('Contract WETH balance after sim: would need real tx to check');
    console.log('');
    console.log('Ready to execute for real. Run with --execute flag.');
  } catch (e) {
    console.log('Simulation REVERTED:', e.reason || e.data?.slice(0, 80) || e.message?.slice(0, 120));
    console.log('');
    console.log('Debugging...');

    // Try to understand WHY it reverted
    // Common issues:
    // 1. Morpho might not have enough WETH to lend
    // 2. PoolKey might be wrong (fee, tickSpacing, hooks)
    // 3. The unlock callback might not be called correctly
    // 4. The pool might not exist with these exact params

    // Check Morpho WETH balance
    const morphoWeth = await new ethers.Contract(WETH, ['function balanceOf(address) view returns (uint256)'], provider)
      .balanceOf('0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb');
    console.log('Morpho WETH balance:', ethers.formatEther(morphoWeth));

    // Check if our contract is deployed correctly
    const code = await provider.getCode(addr);
    console.log('Contract deployed:', code.length > 2);
  }
}

main().catch(e => { console.error(e.message?.slice(0, 200)); process.exit(1); });
