const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const SECRETS_PATH = path.join(process.env.USERPROFILE, '.claude', 'secrets', 'engine.env');

function loadEnv(filepath) {
  const content = fs.readFileSync(filepath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
    process.env[key] = val;
  }
}

loadEnv(SECRETS_PATH);

const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
const wallet = new ethers.Wallet(process.env.THRYXTREASURY_PRIVATE_KEY, provider);

const BURNOUT = '0xE0A048281bF0dA1A24F360e6a3129959FdAA8b07';
const LOCKER = '0x63D2DfEA64b3433F4071A98665bcD7Ca14d93496';
const FEE_LOCKER = '0xF3622742b1E446D92e45E22923Ef11C2fcD55D68';
const WETH = '0x4200000000000000000000000000000000000006';
const OUR_WALLET = wallet.address;

const lockerAbi = [
  'function updateRewardRecipient(address token, uint256 rewardIndex, address newRecipient)',
  'function updateRewardAdmin(address token, uint256 rewardIndex, address newAdmin)',
  'function collectRewards(address token)',
  'function tokenRewards(address token) view returns (tuple(address admin, address recipient, uint256 bps)[])',
  'function feePreferences(address token, uint256 index) view returns (uint8)',
];

const feeLockerAbi = [
  'function availableFees(address feeOwner, address token) view returns (uint256)',
  'function claim(address feeOwner, address token)',
];

async function main() {
  console.log('Wallet:', OUR_WALLET);
  console.log('Balance:', ethers.formatEther(await provider.getBalance(OUR_WALLET)), 'ETH');
  console.log();

  const locker = new ethers.Contract(LOCKER, lockerAbi, wallet);
  const feeLocker = new ethers.Contract(FEE_LOCKER, feeLockerAbi, provider);

  // Step 1: Check current fees available
  console.log('=== Step 1: Check current claimable fees ===');
  const feesWETH = await feeLocker.availableFees(OUR_WALLET, WETH);
  const feesBurnout = await feeLocker.availableFees(OUR_WALLET, BURNOUT);
  console.log('WETH fees claimable:', ethers.formatEther(feesWETH));
  console.log('Burnout fees claimable:', ethers.formatEther(feesBurnout));

  // Step 2: Trigger fee collection (permissionless — anyone can call this)
  console.log('\n=== Step 2: Trigger collectRewards (gas only) ===');
  console.log('This pulls accrued V4 LP fees from the pool into the fee locker...');

  // SIMULATE FIRST
  try {
    await locker.collectRewards.staticCall(BURNOUT);
    console.log('Simulation: SUCCESS — fees will be collected');
  } catch (e) {
    console.log('Simulation: REVERTED —', e.reason || e.message?.slice(0, 100));
    console.log('(Token may not have enough accrued fees yet)');
    return;
  }

  // EXECUTE
  console.log('Sending real tx...');
  const tx = await locker.collectRewards(BURNOUT);
  console.log('Tx:', tx.hash);
  const receipt = await tx.wait();
  console.log('Gas used:', receipt.gasUsed.toString());

  // Step 3: Check fees after collection
  console.log('\n=== Step 3: Check fees after collection ===');
  const feesWETH2 = await feeLocker.availableFees(OUR_WALLET, WETH);
  const feesBurnout2 = await feeLocker.availableFees(OUR_WALLET, BURNOUT);
  console.log('WETH fees claimable:', ethers.formatEther(feesWETH2));
  console.log('Burnout fees claimable:', ethers.formatEther(feesBurnout2));

  const newWETH = feesWETH2 - feesWETH;
  const newBurnout = feesBurnout2 - feesBurnout;
  if (newWETH > 0n || newBurnout > 0n) {
    console.log('\nNEW fees collected:');
    if (newWETH > 0n) console.log('  +', ethers.formatEther(newWETH), 'WETH');
    if (newBurnout > 0n) console.log('  +', ethers.formatEther(newBurnout), 'BURNOUT');
  } else {
    console.log('\nNo new fees collected (pool may not have generated fees since last collection)');
  }

  console.log('\n=== Summary ===');
  console.log('Fee collection works. As admin, you control where future fees go.');
  console.log('To redirect: call updateRewardRecipient(burnout, 0, newAddress)');
  console.log('Future collectRewards calls will send fees to the new address.');
}

main().catch(err => { console.error(err.reason || err.message); process.exit(1); });
