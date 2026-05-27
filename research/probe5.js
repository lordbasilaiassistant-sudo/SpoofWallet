const { ethers } = require("ethers");

const provider = new ethers.JsonRpcProvider("https://1rpc.io/base");

const GLOBAL_FEE_LOCKER = "0xF3622742b1E446D92e45E22923Ef11C2fcD55D68";
const PER_TOKEN_LOCKER = "0x63D2DfEA64b3433F4071A98665bcD7Ca14d93496";
const FACTORY = "0xE85A59c628F7d27878ACeB4bf3b35733630083a9";
const BURNOUT_TOKEN = "0xE0A048281bF0dA1A24F360e6a3129959FdAA8b07";

async function main() {
  // Check burnout fee preferences
  const fpIface = new ethers.Interface([
    "function feePreferences(address, uint256) view returns (uint8)"
  ]);
  
  try {
    const r = await provider.call({
      to: PER_TOKEN_LOCKER,
      data: fpIface.encodeFunctionData("feePreferences", [BURNOUT_TOKEN, 0])
    });
    const val = Number(BigInt(r));
    console.log("Burnout feePreference[0]:", ["Both", "Paired", "Clanker"][val] || val);
  } catch (e) {
    console.log("feePreference error:", e.message.slice(0, 100));
  }

  // Now let's look at recent ClaimedRewards events to find tokens with fee conversion swaps
  const lockerIface = new ethers.Interface([
    "event ClaimedRewards(address indexed token, uint256 amount0, uint256 amount1, uint256[] rewards0, uint256[] rewards1)",
    "event FeesSwapped(address indexed token, address indexed rewardToken, uint256 amountSwapped, address indexed swappedToken, uint256 amountOut)"
  ]);
  
  const latestBlock = await provider.getBlockNumber();
  console.log("Latest block:", latestBlock);
  
  // Look for FeesSwapped events in the last 10000 blocks
  // This proves fee conversion swaps happen
  try {
    const feesSwappedTopic = lockerIface.getEvent("FeesSwapped").topicHash;
    const logs = await provider.getLogs({
      address: PER_TOKEN_LOCKER,
      topics: [feesSwappedTopic],
      fromBlock: latestBlock - 5000,
      toBlock: latestBlock
    });
    console.log("\nFeesSwapped events in last 5000 blocks:", logs.length);
    
    if (logs.length > 0) {
      // Show last 3
      for (const log of logs.slice(-3)) {
        const parsed = lockerIface.parseLog(log);
        console.log("  Token:", parsed.args.token);
        console.log("  Reward token:", parsed.args.rewardToken);
        console.log("  Amount swapped:", ethers.formatEther(parsed.args.amountSwapped));
        console.log("  Swapped into:", parsed.args.swappedToken);
        console.log("  Amount out:", ethers.formatEther(parsed.args.amountOut));
        console.log("  Block:", log.blockNumber);
        console.log("  ---");
      }
    }
  } catch (e) {
    console.log("FeesSwapped log error:", e.message.slice(0, 200));
  }

  // Look for ClaimedRewards events
  try {
    const claimedTopic = lockerIface.getEvent("ClaimedRewards").topicHash;
    const logs = await provider.getLogs({
      address: PER_TOKEN_LOCKER,
      topics: [claimedTopic],
      fromBlock: latestBlock - 5000,
      toBlock: latestBlock
    });
    console.log("\nClaimedRewards events in last 5000 blocks:", logs.length);
    
    if (logs.length > 0) {
      for (const log of logs.slice(-3)) {
        const parsed = lockerIface.parseLog(log);
        console.log("  Token:", parsed.args.token);
        console.log("  Amount0:", ethers.formatEther(parsed.args.amount0));
        console.log("  Amount1:", ethers.formatEther(parsed.args.amount1));
        console.log("  Block:", log.blockNumber);
        console.log("  ---");
      }
    }
  } catch (e) {
    console.log("ClaimedRewards log error:", e.message.slice(0, 200));
  }

  // Check StoreTokens events on the global fee locker
  const feeLockerIface = new ethers.Interface([
    "event StoreTokens(address indexed sender, address indexed feeOwner, address indexed token, uint256 balance, uint256 amount)"
  ]);
  try {
    const storeTopic = feeLockerIface.getEvent("StoreTokens").topicHash;
    const logs = await provider.getLogs({
      address: GLOBAL_FEE_LOCKER,
      topics: [storeTopic],
      fromBlock: latestBlock - 2000,
      toBlock: latestBlock
    });
    console.log("\nStoreTokens events in last 2000 blocks:", logs.length);
    
    // Find the largest deposits
    if (logs.length > 0) {
      const parsed = logs.map(l => feeLockerIface.parseLog(l));
      // Sort by amount descending
      parsed.sort((a, b) => {
        const amtA = BigInt(a.args.amount);
        const amtB = BigInt(b.args.amount);
        return amtB > amtA ? 1 : amtB < amtA ? -1 : 0;
      });
      
      console.log("Top 5 largest deposits:");
      for (const p of parsed.slice(0, 5)) {
        console.log("  FeeOwner:", p.args.feeOwner);
        console.log("  Token:", p.args.token);
        console.log("  Amount:", ethers.formatEther(p.args.amount));
        console.log("  Sender:", p.args.sender);
        console.log("  ---");
      }
    }
  } catch (e) {
    console.log("StoreTokens log error:", e.message.slice(0, 200));
  }
}

main().catch(console.error);
