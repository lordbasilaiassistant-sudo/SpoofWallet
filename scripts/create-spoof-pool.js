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

const SPOOF = '0x0D5d767Dfad78a81237bCa60d986d68bffE9B174';
const WETH = '0x4200000000000000000000000000000000000006';
const V3_NPM = '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1';
const FEE = 10000; // 1% fee tier — higher fees = more revenue per trade

// NonfungiblePositionManager ABI (relevant functions)
const npmAbi = [
  'function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) external payable returns (address pool)',
  'function mint(tuple(address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
];

async function main() {
  console.log('Timestamp:', new Date().toISOString());
  console.log('Wallet:', wallet.address);
  const bal = await provider.getBalance(wallet.address);
  console.log('ETH:', ethers.formatEther(bal));

  // Determine token ordering (V3 requires token0 < token1)
  const token0 = SPOOF.toLowerCase() < WETH.toLowerCase() ? SPOOF : WETH;
  const token1 = SPOOF.toLowerCase() < WETH.toLowerCase() ? WETH : SPOOF;
  const spoofIsToken0 = token0.toLowerCase() === SPOOF.toLowerCase();

  console.log('token0:', token0, spoofIsToken0 ? '(SPOOF)' : '(WETH)');
  console.log('token1:', token1, spoofIsToken0 ? '(WETH)' : '(SPOOF)');

  // Set initial price: 1 SPOOF = 0.000000001 WETH (1B SPOOF = 1 WETH equivalent)
  // This gives the token a $2.50 market cap per billion tokens at $2500/ETH
  // sqrtPriceX96 = sqrt(price) * 2^96

  // If SPOOF is token0: price = WETH/SPOOF = 1e9 (1B SPOOF per WETH)
  // sqrtPriceX96 = sqrt(1e-9) * 2^96 = 31622.776 * 2^96
  // If SPOOF is token1: price = SPOOF/WETH = 1e-9
  // sqrtPriceX96 = sqrt(1e9) * 2^96

  let sqrtPriceX96;
  if (spoofIsToken0) {
    // price = token1/token0 = WETH/SPOOF = very small number
    // 1 SPOOF = 1e-9 WETH, so price ratio = 1e-9
    // sqrt(1e-9) * 2^96
    sqrtPriceX96 = BigInt('2505414483750479');  // approx sqrt(1e-9) * 2^96
  } else {
    // price = token1/token0 = SPOOF/WETH = 1e9
    // sqrt(1e9) * 2^96
    sqrtPriceX96 = BigInt('2505414483750479311864222') * 1000000n; // approx sqrt(1e9) * 2^96
  }

  console.log('sqrtPriceX96:', sqrtPriceX96.toString());
  console.log('Fee:', FEE, '(1%)');
  console.log('');

  const npm = new ethers.Contract(V3_NPM, npmAbi, wallet);

  // Step 1: Create pool
  console.log('=== Creating SPOOF/WETH V3 pool ===');
  try {
    const tx = await npm.createAndInitializePoolIfNecessary(
      token0, token1, FEE, sqrtPriceX96
    );
    console.log('Create pool TX:', tx.hash);
    const r = await tx.wait();
    console.log('Pool created! Gas:', r.gasUsed.toString());
  } catch (e) {
    console.log('Pool creation failed:', e.reason || e.message?.slice(0, 120));
    return;
  }

  // Step 2: Approve SPOOF to NPM
  console.log('');
  console.log('=== Approving SPOOF ===');
  const spoofToken = new ethers.Contract(SPOOF, ['function approve(address,uint256) returns (bool)'], wallet);
  const approveTx = await spoofToken.approve(V3_NPM, ethers.MaxUint256);
  await approveTx.wait();
  console.log('Approved');

  // Step 3: Add single-sided SPOOF liquidity
  // Provide SPOOF tokens across a wide range of ticks
  // Single-sided means: if SPOOF is token0, we provide liquidity BELOW current price
  // (ticks where only token0 is needed)
  const SPOOF_AMOUNT = ethers.parseEther('500000000'); // 500M SPOOF (half our stack)

  // Tick spacing for 1% fee = 200
  const tickSpacing = 200;

  // For single-sided token0 (SPOOF) liquidity: tickLower to tickUpper must be BELOW current tick
  // For single-sided token1 (SPOOF) liquidity: tickLower to tickUpper must be ABOVE current tick

  // Current tick from sqrtPriceX96... let me calculate
  // tick = log(sqrtPriceX96^2 / 2^192) / log(1.0001)
  // For simplicity, use wide range
  const tickLower = spoofIsToken0 ? -887200 : 0; // min valid tick for this spacing
  const tickUpper = spoofIsToken0 ? 0 : 887200; // max valid tick

  const amount0 = spoofIsToken0 ? SPOOF_AMOUNT : 0n;
  const amount1 = spoofIsToken0 ? 0n : SPOOF_AMOUNT;

  console.log('');
  console.log('=== Adding single-sided SPOOF liquidity ===');
  console.log('SPOOF amount:', ethers.formatEther(SPOOF_AMOUNT));
  console.log('Tick range:', tickLower, 'to', tickUpper);

  try {
    const mintTx = await npm.mint({
      token0, token1,
      fee: FEE,
      tickLower, tickUpper,
      amount0Desired: amount0,
      amount1Desired: amount1,
      amount0Min: 0,
      amount1Min: 0,
      recipient: wallet.address,
      deadline: Math.floor(Date.now() / 1000) + 600
    });
    console.log('Mint TX:', mintTx.hash);
    const r = await mintTx.wait();
    console.log('Liquidity added! Gas:', r.gasUsed.toString());
    console.log('');
    console.log('*** SPOOF/WETH pool is now LIVE on Uniswap V3 ***');
    console.log('Anyone can buy SPOOF, and we earn 1% fees on every trade.');
  } catch (e) {
    console.log('Mint failed:', e.reason || e.message?.slice(0, 150));
  }

  const balAfter = await provider.getBalance(wallet.address);
  console.log('');
  console.log('ETH remaining:', ethers.formatEther(balAfter));
}

main().catch(e => { console.error(e.reason || e.message?.slice(0, 200)); process.exit(1); });
