const { ethers } = require("ethers");

const provider = new ethers.JsonRpcProvider("https://mainnet.base.org");

const PER_TOKEN_LOCKER = "0x63D2DfEA64b3433F4071A98665bcD7Ca14d93496";
const WETH = "0x4200000000000000000000000000000000000006";

async function main() {
  const latestBlock = await provider.getBlockNumber();
  
  const lockerIface = new ethers.Interface([
    "event FeesSwapped(address indexed token, address indexed rewardToken, uint256 amountSwapped, address indexed swappedToken, uint256 amountOut)"
  ]);

  // Get FeesSwapped events and analyze WETH amounts out
  const feesSwappedTopic = lockerIface.getEvent("FeesSwapped").topicHash;
  const logs = await provider.getLogs({
    address: PER_TOKEN_LOCKER,
    topics: [feesSwappedTopic],
    fromBlock: latestBlock - 1500,
    toBlock: latestBlock
  });

  console.log("Total FeesSwapped events:", logs.length);
  
  // Parse all and categorize
  let wethSwapCount = 0;
  let totalWethOut = 0n;
  let bigSwaps = [];
  
  for (const log of logs) {
    const parsed = lockerIface.parseLog(log);
    const swappedInto = parsed.args[3];
    const amountOut = BigInt(parsed.args[4]);
    
    if (swappedInto.toLowerCase() === WETH.toLowerCase()) {
      wethSwapCount++;
      totalWethOut += amountOut;
      
      if (amountOut > ethers.parseEther("0.001")) {
        bigSwaps.push({
          token: parsed.args[0],
          rewardToken: parsed.args[1],
          amountSwapped: parsed.args[2],
          amountOut: amountOut,
          block: log.blockNumber,
          tx: log.transactionHash
        });
      }
    }
  }
  
  console.log("\nSwaps into WETH:", wethSwapCount);
  console.log("Swaps into clanker tokens:", logs.length - wethSwapCount);
  console.log("Total WETH output from swaps:", ethers.formatEther(totalWethOut));
  
  // Sort by WETH amount descending
  bigSwaps.sort((a, b) => b.amountOut > a.amountOut ? 1 : b.amountOut < a.amountOut ? -1 : 0);
  
  console.log("\nSwaps with > 0.001 WETH output:", bigSwaps.length);
  console.log("\nTop 10 largest WETH-producing swaps:");
  for (const s of bigSwaps.slice(0, 10)) {
    console.log("  Token:", s.token);
    console.log("  ClankerTokenSwapped:", ethers.formatEther(s.amountSwapped));
    console.log("  WETH Out:", ethers.formatEther(s.amountOut));
    console.log("  Block:", s.block);
    console.log("  Tx:", s.tx);
    console.log("  ---");
  }
  
  // Extrapolate: ~1500 blocks is ~50 minutes on Base (2s blocks)
  // So per hour: totalWethOut * (3600 / (1500*2))
  const perHour = (totalWethOut * 3600n) / (1500n * 2n);
  const perDay = perHour * 24n;
  console.log("\nEstimated WETH swapped per hour:", ethers.formatEther(perHour));
  console.log("Estimated WETH swapped per day:", ethers.formatEther(perDay));
  console.log("At 5% sandwich extraction rate:", ethers.formatEther(perDay * 5n / 100n), "WETH/day");
  console.log("At 2% sandwich extraction rate:", ethers.formatEther(perDay * 2n / 100n), "WETH/day");

  // Now check: who is calling collectRewards? Is it the hook (afterSwap) or external callers?
  // If it's the hook, the swap happens via _uniSwapUnlocked (inside the pool unlock)
  // If it's external, the swap happens via _uniSwapLocked (via universal router)
  // Both have 0 slippage protection
  
  // Let's check the tx of one of the big swaps to see who triggered it
  if (bigSwaps.length > 0) {
    const tx = await provider.getTransaction(bigSwaps[0].tx);
    console.log("\nTop swap tx analysis:");
    console.log("  From:", tx.from);
    console.log("  To:", tx.to);
    console.log("  Input (first 10 bytes):", tx.data.slice(0, 20));
    
    // collectRewards(address) selector
    const collectSig = ethers.id("collectRewards(address)").slice(0, 10);
    console.log("  collectRewards selector:", collectSig);
    
    // Check if the tx target is the hook, universal router, or the locker itself
    if (tx.to?.toLowerCase() === PER_TOKEN_LOCKER.toLowerCase()) {
      console.log("  TX TARGET: Per-Token Locker (direct collectRewards call)");
    }
  }
}

main().catch(console.error);
