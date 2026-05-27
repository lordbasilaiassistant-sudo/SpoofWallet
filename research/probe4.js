const { ethers } = require("ethers");

const rpcs = [
  "https://mainnet.base.org",
  "https://1rpc.io/base",
  "https://developer-access-mainnet.base.org",
  "https://gateway.tenderly.co/public/base"
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
      const p = getProvider();
      return await p.call({ to, data });
    } catch (e) {
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  console.log(`[${label}] FAILED`);
  return null;
}

const GLOBAL_FEE_LOCKER = "0xF3622742b1E446D92e45E22923Ef11C2fcD55D68";
const PER_TOKEN_LOCKER = "0x63D2DfEA64b3433F4071A98665bcD7Ca14d93496";
const FACTORY = "0xE85A59c628F7d27878ACeB4bf3b35733630083a9";
const WETH = "0x4200000000000000000000000000000000000006";
const OUR_WALLET = "0x7a3E312Ec6e20a9F62fE2405938EB9060312E334";

async function main() {
  // ATTACK VECTOR 1: The burnout token - we ARE the admin and recipient
  // Can we update the recipient to redirect someone else's fees? No - that's our own token.
  // But interesting: we control a real token with 5 LP positions.
  
  console.log("=== ATTACK VECTOR: DUST ROUNDING IN FEE DISTRIBUTION ===");
  console.log("In _handleFees, the fee distribution uses integer division:");
  console.log("  tokenToDistribute = rewardBps[i] * amount / BASIS_POINTS");
  console.log("  The remainder (dust) goes to the LAST swap recipient");
  console.log("  If toSwapCount == 0, dust goes to LAST distribute recipient");
  console.log("");
  console.log("For a single recipient (like burnout with 10000 bps), no rounding issue.");
  console.log("For multiple recipients, dust < numRecipients per collection.");
  console.log("Not economically significant. LOW severity.");

  console.log("\n=== ATTACK VECTOR: WITHDRAW FUNCTIONS ===");
  console.log("withdrawERC20(token, recipient) and withdrawETH(recipient)");
  console.log("Both are onlyOwner on the per-token locker.");
  console.log("Owner is: 0xEea96d959963EaB488A3d4B7d5d347785cf1Eab8");
  console.log("These are legitimate rescue functions. BLOCKED for attackers.");
  
  console.log("\n=== ATTACK VECTOR: onERC721Received ===");
  console.log("The locker accepts ERC721 ONLY from the factory.");
  console.log("  if (from != factory) revert Unauthorized()");
  console.log("This blocks sending arbitrary NFTs to the locker.");
  console.log("But wait - 'from' in onERC721Received is the previous owner.");
  console.log("If the FACTORY sends an NFT (via safeTransfer), from=factory -> accepted.");
  console.log("No one else can send NFTs. BLOCKED.");
  
  console.log("\n=== ATTACK VECTOR: TOKEN ADMIN TAKEOVER ===");
  console.log("ClankerToken.updateAdmin() requires msg.sender == _admin");
  console.log("For burnout, _admin = 0x7a3E (our wallet).");
  console.log("If we could take over another token's admin, we could:");
  console.log("  1. Change their admin to ourselves");
  console.log("  2. But this doesn't affect fee distribution - that's in the LOCKER");
  console.log("  3. The locker stores rewardAdmins separately from token admin");
  console.log("Token admin != locker rewardAdmin. They're independent.");

  // CRITICAL: Check if there's a way to call storeFees directly
  console.log("\n=== ATTACK VECTOR: BECOME AN ALLOWED DEPOSITOR ===");
  console.log("storeFees requires allowedDepositors[msg.sender] == true");
  console.log("addDepositor is onlyOwner (fee locker owner)");
  console.log("Fee locker owner = 0xEea96d...");
  console.log("BLOCKED unless we compromise the owner.");
  
  // Check what happens if we call collectRewards for a token with large fees
  // and the feePreference involves a swap
  console.log("\n=== ATTACK VECTOR: SELF-TRIGGERED SANDWICH ===");
  console.log("CONFIRMED VIABLE. Here's why:");
  console.log("");
  console.log("1. collectRewards(token) is permissionless");
  console.log("2. If any recipient has FeeIn.Paired preference, the locker swaps");
  console.log("   clanker_token -> WETH (or vice versa) through the pool");
  console.log("3. The swap has amountOutMinimum: 0");
  console.log("4. We can:");
  console.log("   a. Find tokens with large uncollected fees");
  console.log("   b. Check their feePreferences for swappable recipients");
  console.log("   c. In a single block:");
  console.log("      - Buy output token on the pool (frontrun)");
  console.log("      - Call collectRewards(token) (triggers the 0-slippage swap)");
  console.log("      - Sell output token (backrun)");
  console.log("");
  console.log("Profit scales with:");
  console.log("  - Size of uncollected fees");
  console.log("  - Illiquidity of the pool");
  console.log("  - Proportion of fees designated for swap");
  
  // Now let me check: does the MEV module block this?
  console.log("\n=== MEV MODULE INTERACTION ===");
  console.log("The _collectRewards function checks _mevModuleOperating()");
  console.log("If the MEV module is still active, collection is SKIPPED");
  console.log("MEV module has a MAX_MEV_MODULE_DELAY after pool creation");
  console.log("So for NEW pools, the MEV module blocks collection");
  console.log("For OLD pools (past MAX_MEV_MODULE_DELAY), it's open season");
  console.log("");
  console.log("Additionally: _mevModuleOperating checks mevModuleEnabled(poolId)");
  console.log("The hook can disable the MEV module per pool");
  console.log("Once disabled or expired, collectRewards works freely");

  // The _inCollect guard
  console.log("\n=== RE-ENTRANCY GUARD: _inCollect ===");
  console.log("_inCollect is a boolean set before collection, cleared after");
  console.log("This prevents recursive collection but NOT sandwich attacks");
  console.log("The sandwich happens in SEPARATE transactions, not re-entrant calls");

  // Let's look at what tokens have large uncollected fees
  // We'd need to enumerate tokens and check their V4 positions
  // For now, estimate based on the 432 WETH in the fee locker
  
  console.log("\n=== VALUE AT RISK ESTIMATION ===");
  console.log("432 WETH sitting in the fee locker (already collected + stored)");
  console.log("Unknown additional WETH sitting as uncollected fees in V4 positions");
  console.log("The per-token locker holds 2M+ position NFTs");
  console.log("Each position accrues fees from swaps on its pool");
  console.log("");
  console.log("Conservative estimate: if 10% of fees involve a swap preference,");
  console.log("and average sandwich profit is 5% of swap amount,");
  console.log("ongoing extraction rate = 0.5% of ALL Clanker V4 fee revenue");

  // Can we also enumerate which tokens use FeeConversion (FeeIn.Paired)?
  // The feePreferences mapping is public
  console.log("\n=== CHECKING FEE PREFERENCES FOR BURNOUT ===");
  const fpSig = ethers.id("feePreferences(address,uint256)").slice(0,10);
  let r = await safeCall(PER_TOKEN_LOCKER, 
    fpSig + ethers.zeroPadValue(
      "0xE0A048281bF0dA1A24F360e6a3129959FdAA8b07", 32).slice(2) + 
      ethers.zeroPadValue("0x0", 32).slice(2), 
    "burnout-fp-0");
  if (r) {
    const val = BigInt(r);
    const feeInNames = ["Both", "Paired", "Clanker"];
    console.log("Burnout feePreference[0]:", feeInNames[Number(val)] || val.toString());
  }
}

main().catch(console.error);
