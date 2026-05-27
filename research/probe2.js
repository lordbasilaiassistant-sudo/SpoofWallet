const { ethers } = require("ethers");

const RPC = "https://mainnet.base.org";
const provider = new ethers.JsonRpcProvider(RPC);

const GLOBAL_FEE_LOCKER = "0xF3622742b1E446D92e45E22923Ef11C2fcD55D68";
const PER_TOKEN_LOCKER = "0x63D2DfEA64b3433F4071A98665bcD7Ca14d93496";
const FACTORY = "0xE85A59c628F7d27878ACeB4bf3b35733630083a9";
const HOOK = "0xDd5EeaFf7BD481AD55Db083062b13a3cdf0A68CC";
const WETH = "0x4200000000000000000000000000000000000006";
const BURNOUT_TOKEN = "0xE0A048281bF0dA1A24F360e6a3129959FdAA8b07";
const POSITION_MANAGER = "0x7C5f5A4bBd8fD63184577525326123B519429bDc"; // base posm
const OUR_WALLET = "0x7a3E312Ec6e20a9F62fE2405938EB9060312E334";
const OWNER = "0xEea96d959963EaB488A3d4B7d5d347785cf1Eab8";

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function safeCall(to, data, label) {
  try {
    await sleep(200);
    const result = await provider.call({ to, data });
    return result;
  } catch (e) {
    console.log(`[${label}] Error: ${e.message.slice(0, 80)}`);
    return null;
  }
}

async function main() {
  // 1. Check if factory is deprecated - this controls if we can deploy tokens
  console.log("=== FACTORY CONFIG ===");
  let result = await safeCall(FACTORY, "0xfcfb2d65", "deprecated"); // deprecated() = 0xfcfb2d65 actually... let me check
  // deprecated() selector
  const deprecatedSig = ethers.id("deprecated()").slice(0, 10);
  result = await safeCall(FACTORY, deprecatedSig, "deprecated");
  if (result) console.log("Factory deprecated:", BigInt(result) !== 0n);
  
  // 2. Check who are allowed depositors beyond the per-token locker
  // Let me check if the hook is also an allowed depositor
  const allowedSig = ethers.id("allowedDepositors(address)").slice(0, 10);
  result = await safeCall(GLOBAL_FEE_LOCKER, allowedSig + ethers.zeroPadValue(HOOK, 32).slice(2), "hook depositor");
  if (result) console.log("Hook is allowed depositor:", BigInt(result) !== 0n);

  // Check if factory is allowed depositor
  result = await safeCall(GLOBAL_FEE_LOCKER, allowedSig + ethers.zeroPadValue(FACTORY, 32).slice(2), "factory depositor");
  if (result) console.log("Factory is allowed depositor:", BigInt(result) !== 0n);

  // 3. Key question: can we call deployToken on the factory as any user?
  // The deployToken function is public and not access-controlled beyond `deprecated`
  console.log("\n=== KEY INSIGHT: deployToken IS PUBLIC ===");
  console.log("Anyone can deploy a token via the factory if:");
  console.log("  1. Factory is not deprecated");
  console.log("  2. Hook, locker, mev module are all enabled");
  console.log("  3. The caller specifies the reward recipients");

  // 4. Check the claim function on fee locker - can we claim for any feeOwner?
  console.log("\n=== CLAIM MECHANICS ===");
  console.log("claim(feeOwner, token) sends tokens TO feeOwner - permissionless");
  console.log("But feeOwner must have a balance to claim");
  
  // 5. What if we deploy a token where WE are the rewardRecipient?
  // Then when collectRewards is called for our token, fees go to fee locker under OUR address
  // But our pool would have minimal/no volume...
  
  // 6. CRITICAL: Check the fee conversion swap - amountOutMinimum: 0
  console.log("\n=== SANDWICH VECTOR: amountOutMinimum = 0 ===");
  console.log("In _uniSwapLocked (line 621):");
  console.log("  amountOutMinimum: 0 <-- NO SLIPPAGE PROTECTION");
  console.log("Every collectRewards call that triggers a fee conversion swap");
  console.log("is sandwichable with 0 slippage protection.");
  
  // 7. Check WETH balance in fee locker to estimate total value at risk
  const balSig = ethers.id("balanceOf(address)").slice(0, 10);
  result = await safeCall(WETH, balSig + ethers.zeroPadValue(GLOBAL_FEE_LOCKER, 32).slice(2), "weth balance");
  if (result) console.log("\nWETH in Global Fee Locker:", ethers.formatEther(result));
  
  result = await safeCall(WETH, balSig + ethers.zeroPadValue(PER_TOKEN_LOCKER, 32).slice(2), "locker weth");
  if (result) console.log("WETH in Per-Token Locker:", ethers.formatEther(result));

  // 8. Check if there are other lockers that are allowed depositors
  // We know 0x63D2... is one. Let me check the old locker if there is one
  const OLD_LOCKER = "0x616ed48C2F8D07A84c23a2eBE23FB5f2D tried";
  
  // 9. Check our wallet's fee balance
  const avFeesSig = ethers.id("availableFees(address,address)").slice(0, 10);
  result = await safeCall(GLOBAL_FEE_LOCKER, avFeesSig + ethers.zeroPadValue(OUR_WALLET, 32).slice(2) + ethers.zeroPadValue(WETH, 32).slice(2), "our fees");
  if (result) console.log("\nOur wallet available WETH fees:", ethers.formatEther(result));
  
  // Check the owner address fees
  result = await safeCall(GLOBAL_FEE_LOCKER, avFeesSig + ethers.zeroPadValue(OWNER, 32).slice(2) + ethers.zeroPadValue(WETH, 32).slice(2), "owner fees");
  if (result) console.log("Owner available WETH fees:", ethers.formatEther(result));

  // 10. Check collectRewards - it's permissionless
  console.log("\n=== collectRewards PERMISSIONLESS ===");
  console.log("Anyone can call collectRewards(token) on the per-token locker");
  console.log("This collects fees from V4 pool and distributes them");
  console.log("Distribution goes to rewardRecipients set at deployment time");
  
  // 11. Check the updateRewardRecipient access control
  console.log("\n=== updateRewardRecipient ===");
  console.log("Only rewardAdmins[index] can call updateRewardRecipient");
  console.log("Only rewardAdmins[index] can call updateRewardAdmin");
  console.log("These are set at deployment time by whoever calls deployToken");

  // 12. THE BIG QUESTION: Can we deploy a token through the factory
  // with the SAME pool key as an existing token?
  console.log("\n=== POOL COLLISION ATTACK ===");
  console.log("If two tokens share the same pool, fees from one could go to the other's recipient");
  console.log("V4 pool keys are: (currency0, currency1, fee, tickSpacing, hooks)");
  console.log("If we deploy a new token, it gets a new address -> new pool key");
  console.log("Pool collision is NOT possible because token address is part of pool key");
  
  // 13. Check if the locker holds any NFT positions
  // The position manager is an ERC721
  const positionMgr = "0x7C5f5A4bBd8fD63184577525326123B519429bDc"; // likely on base
  result = await safeCall(positionMgr, balSig + ethers.zeroPadValue(PER_TOKEN_LOCKER, 32).slice(2), "nft balance");
  if (result) console.log("\nLP NFTs held by Per-Token Locker:", BigInt(result).toString());
}

main().catch(console.error);
