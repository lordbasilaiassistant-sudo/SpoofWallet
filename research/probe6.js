const { ethers } = require("ethers");

const provider = new ethers.JsonRpcProvider("https://mainnet.base.org");

const PER_TOKEN_LOCKER = "0x63D2DfEA64b3433F4071A98665bcD7Ca14d93496";
const GLOBAL_FEE_LOCKER = "0xF3622742b1E446D92e45E22923Ef11C2fcD55D68";
const WETH = "0x4200000000000000000000000000000000000006";

async function main() {
  const latestBlock = await provider.getBlockNumber();
  console.log("Latest block:", latestBlock);

  // Base public RPC has a limit of ~2000 blocks for getLogs
  const lockerIface = new ethers.Interface([
    "event FeesSwapped(address indexed token, address indexed rewardToken, uint256 amountSwapped, address indexed swappedToken, uint256 amountOut)",
    "event ClaimedRewards(address indexed token, uint256 amount0, uint256 amount1, uint256[] rewards0, uint256[] rewards1)"
  ]);

  // Search for FeesSwapped in recent blocks (smaller range)
  try {
    const feesSwappedTopic = lockerIface.getEvent("FeesSwapped").topicHash;
    console.log("FeesSwapped topic:", feesSwappedTopic);
    
    const logs = await provider.getLogs({
      address: PER_TOKEN_LOCKER,
      topics: [feesSwappedTopic],
      fromBlock: latestBlock - 1500,
      toBlock: latestBlock
    });
    console.log("FeesSwapped events in last 1500 blocks:", logs.length);
    
    for (const log of logs.slice(-5)) {
      const parsed = lockerIface.parseLog(log);
      console.log("  Token:", parsed.args[0]);
      console.log("  RewardToken:", parsed.args[1]);
      console.log("  AmountSwapped:", ethers.formatEther(parsed.args[2]));
      console.log("  SwappedInto:", parsed.args[3]);
      console.log("  AmountOut:", ethers.formatEther(parsed.args[4]));
      console.log("  Block:", log.blockNumber, " Tx:", log.transactionHash);
      console.log("  ---");
    }
  } catch (e) {
    console.log("FeesSwapped error:", e.message.slice(0, 300));
  }

  // Search for ClaimedRewards 
  try {
    const claimedTopic = lockerIface.getEvent("ClaimedRewards").topicHash;
    const logs = await provider.getLogs({
      address: PER_TOKEN_LOCKER,
      topics: [claimedTopic],
      fromBlock: latestBlock - 1500,
      toBlock: latestBlock
    });
    console.log("\nClaimedRewards events in last 1500 blocks:", logs.length);
    
    for (const log of logs.slice(-5)) {
      try {
        const parsed = lockerIface.parseLog(log);
        console.log("  Token:", parsed.args[0]);
        console.log("  Amount0:", ethers.formatEther(parsed.args[1]));
        console.log("  Amount1:", ethers.formatEther(parsed.args[2]));
        console.log("  Block:", log.blockNumber);
        console.log("  ---");
      } catch {}
    }
  } catch (e) {
    console.log("ClaimedRewards error:", e.message.slice(0, 300));
  }

  // Also search for StoreTokens on the global fee locker - this shows what's flowing in
  const feeLockerIface = new ethers.Interface([
    "event StoreTokens(address indexed sender, address indexed feeOwner, address indexed token, uint256 balance, uint256 amount)"
  ]);
  try {
    const storeTopic = feeLockerIface.getEvent("StoreTokens").topicHash;
    const logs = await provider.getLogs({
      address: GLOBAL_FEE_LOCKER,
      topics: [storeTopic],
      fromBlock: latestBlock - 1500,
      toBlock: latestBlock
    });
    console.log("\nStoreTokens events in last 1500 blocks:", logs.length);
    
    // Filter for WETH deposits (the money)
    const wethDeposits = [];
    for (const log of logs) {
      const parsed = feeLockerIface.parseLog(log);
      if (parsed.args[2].toLowerCase() === WETH.toLowerCase()) {
        wethDeposits.push(parsed);
      }
    }
    console.log("WETH StoreTokens:", wethDeposits.length);
    
    // Sum total WETH deposited
    let totalWeth = 0n;
    for (const d of wethDeposits) {
      totalWeth += BigInt(d.args[4]); // amount
    }
    console.log("Total WETH deposited in period:", ethers.formatEther(totalWeth));
    
    // Show top deposits
    wethDeposits.sort((a, b) => {
      const aa = BigInt(a.args[4]);
      const bb = BigInt(b.args[4]);
      return bb > aa ? 1 : bb < aa ? -1 : 0;
    });
    console.log("\nTop 5 WETH deposits:");
    for (const d of wethDeposits.slice(0, 5)) {
      console.log("  FeeOwner:", d.args[1]);
      console.log("  Amount:", ethers.formatEther(d.args[4]));
      console.log("  Balance:", ethers.formatEther(d.args[3]));
      console.log("  ---");
    }
  } catch (e) {
    console.log("StoreTokens error:", e.message.slice(0, 300));
  }
}

main().catch(console.error);
