const { ethers } = require("ethers");

// Use multiple RPCs to avoid rate limits
const rpcs = [
  "https://mainnet.base.org",
  "https://1rpc.io/base",
  "https://developer-access-mainnet.base.org"
];
let rpcIdx = 0;
function getProvider() {
  const p = new ethers.JsonRpcProvider(rpcs[rpcIdx % rpcs.length]);
  rpcIdx++;
  return p;
}

async function safeCall(to, data, label) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const provider = getProvider();
      const result = await provider.call({ to, data });
      return result;
    } catch (e) {
      if (attempt < 2) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      console.log(`[${label}] FAILED after 3 attempts`);
      return null;
    }
  }
}

const GLOBAL_FEE_LOCKER = "0xF3622742b1E446D92e45E22923Ef11C2fcD55D68";
const PER_TOKEN_LOCKER = "0x63D2DfEA64b3433F4071A98665bcD7Ca14d93496";
const FACTORY = "0xE85A59c628F7d27878ACeB4bf3b35733630083a9";
const HOOK = "0xDd5EeaFf7BD481AD55Db083062b13a3cdf0A68CC";
const WETH = "0x4200000000000000000000000000000000000006";
const BURNOUT_TOKEN = "0xE0A048281bF0dA1A24F360e6a3129959FdAA8b07";
const OUR_WALLET = "0x7a3E312Ec6e20a9F62fE2405938EB9060312E334";
const OWNER = "0xEea96d959963EaB488A3d4B7d5d347785cf1Eab8";

async function main() {
  // CRITICAL CHECKS IN PARALLEL-ISH WITH DELAYS
  
  // 1. WETH balance in fee locker
  const balSig = ethers.id("balanceOf(address)").slice(0, 10);
  let r = await safeCall(WETH, balSig + ethers.zeroPadValue(GLOBAL_FEE_LOCKER, 32).slice(2), "weth-fee-locker");
  if (r) console.log("WETH in Fee Locker:", ethers.formatEther(r));

  // 2. WETH in per-token locker  
  r = await safeCall(WETH, balSig + ethers.zeroPadValue(PER_TOKEN_LOCKER, 32).slice(2), "weth-locker");
  if (r) console.log("WETH in Per-Token Locker:", ethers.formatEther(r));

  // 3. Factory deprecated?
  r = await safeCall(FACTORY, ethers.id("deprecated()").slice(0,10), "deprecated");
  if (r) console.log("Factory deprecated:", BigInt(r) !== 0n);

  // 4. Hook is allowed depositor?
  const adSig = ethers.id("allowedDepositors(address)").slice(0,10);
  r = await safeCall(GLOBAL_FEE_LOCKER, adSig + ethers.zeroPadValue(HOOK, 32).slice(2), "hook-depositor");
  if (r) console.log("Hook is allowed depositor:", BigInt(r) !== 0n);

  // 5. Our wallet WETH fees
  const avSig = ethers.id("availableFees(address,address)").slice(0,10);
  r = await safeCall(GLOBAL_FEE_LOCKER, avSig + ethers.zeroPadValue(OUR_WALLET, 32).slice(2) + ethers.zeroPadValue(WETH, 32).slice(2), "our-fees");
  if (r) console.log("Our WETH fees:", ethers.formatEther(r));

  // 6. Burnout token reward info
  const iface = new ethers.Interface([
    "function tokenRewards(address) view returns (tuple(address token, tuple(address,address,uint24,int24,address) poolKey, uint256 positionId, uint256 numPositions, uint16[] rewardBps, address[] rewardAdmins, address[] rewardRecipients))"
  ]);
  r = await safeCall(PER_TOKEN_LOCKER, iface.encodeFunctionData("tokenRewards", [BURNOUT_TOKEN]), "burnout-rewards");
  if (r) {
    try {
      const decoded = iface.decodeFunctionResult("tokenRewards", r);
      const info = decoded[0];
      console.log("\nBurnout Token Reward Info:");
      console.log("  Position ID:", info.positionId.toString());
      console.log("  Num Positions:", info.numPositions.toString());
      console.log("  BPS:", info.rewardBps.map(b => b.toString()));
      console.log("  Admins:", info.rewardAdmins);
      console.log("  Recipients:", info.rewardRecipients);
    } catch (e) {
      console.log("Decode error:", e.message.slice(0, 200));
    }
  }

  // 7. Check if factory admin for our wallet
  const adminSig = ethers.id("admins(address)").slice(0,10);
  r = await safeCall(FACTORY, adminSig + ethers.zeroPadValue(OUR_WALLET, 32).slice(2), "admin-check");
  if (r) console.log("\nOur wallet is factory admin:", BigInt(r) !== 0n);

  // 8. Check hook locker/mev module configuration
  // Get poolCreationTimestamp for the burnout pool
  // First need the poolId
  
  // 9. Check how many depositors the fee locker has by checking several known lockers
  const KNOWN_LOCKERS = [
    "0x616ed48C2F8D07A84c23a2eBE23FB5f2D8B66b72", // possible old locker
    "0x4D7572040B84b41a6AA2efE4A93eFFF182388F88", // another possible
  ];
  for (const locker of KNOWN_LOCKERS) {
    try {
      r = await safeCall(GLOBAL_FEE_LOCKER, adSig + ethers.zeroPadValue(locker, 32).slice(2), `locker-${locker.slice(0,8)}`);
      if (r && BigInt(r) !== 0n) console.log("Allowed depositor found:", locker);
    } catch {}
  }

  // 10. THE SANDWICH ATTACK PROOF
  console.log("\n=== SANDWICH ATTACK ANALYSIS ===");
  console.log("The _uniSwapLocked function in ClankerLpLockerFeeConversion:");
  console.log("  - Uses amountOutMinimum: 0 (line 627)");
  console.log("  - Uses sqrtPriceLimitX96: MIN_SQRT_PRICE+1 or MAX_SQRT_PRICE-1");
  console.log("  - No deadline protection (uses block.timestamp)");
  console.log("  - collectRewards() is PERMISSIONLESS - anyone can trigger it");
  console.log("");
  console.log("Attack sequence:");
  console.log("  1. Monitor mempool for collectRewards(token) calls");
  console.log("  2. For any token with feePreference = FeeIn.Paired or FeeIn.Clanker:");
  console.log("     The locker will swap accumulated clanker->WETH or WETH->clanker");
  console.log("  3. Frontrun: buy the output token on the same pool");
  console.log("  4. Let the collectRewards swap execute with 0 slippage");
  console.log("  5. Backrun: sell the output token");
  console.log("  6. Profit = the entire slippage of the locker's swap");
  console.log("");
  console.log("CRITICAL AMPLIFIER: We can TRIGGER collectRewards ourselves");
  console.log("  - Call collectRewards(token) for tokens with large uncollected fees");
  console.log("  - Sandwich our own collectRewards call");
  console.log("  - This is not waiting for someone else - we create the opportunity");

  // 11. THE _uniSwapUnlocked function is called from the hook
  console.log("\n=== HOOK-TRIGGERED COLLECTION ===");
  console.log("collectRewardsWithoutUnlock is called by the hook during afterSwap");
  console.log("This means every swap on a Clanker pool can trigger fee collection");
  console.log("The hook-triggered path uses _uniSwapUnlocked which swaps DIRECTLY on V4");
  console.log("This is ALSO sandwichable - same 0 slippage protection");
}

main().catch(console.error);
