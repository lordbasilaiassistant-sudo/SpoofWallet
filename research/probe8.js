const { ethers } = require("ethers");

const provider = new ethers.JsonRpcProvider("https://mainnet.base.org");

const PER_TOKEN_LOCKER = "0x63D2DfEA64b3433F4071A98665bcD7Ca14d93496";
const UNIVERSAL_ROUTER = "0x6fF5693b99212Da76ad316178A184AB56D299b43"; // base universal router v2
const HOOK = "0xDd5EeaFf7BD481AD55Db083062b13a3cdf0A68CC";

async function main() {
  // The top swap TX goes to 0xd0a40c65... which is likely the universal router or a swap aggregator
  // Let's check the actual tx receipt to see internal calls
  const txHash = "0x68915d3bad45dbb5e7a6636715fe212d37e5b5b0d1511aec2d25916d66a7ea84";
  const receipt = await provider.getTransactionReceipt(txHash);
  
  console.log("=== TX RECEIPT ===");
  console.log("Status:", receipt.status);
  console.log("From:", receipt.from);
  console.log("To:", receipt.to);
  console.log("Gas used:", receipt.gasUsed.toString());
  console.log("Logs count:", receipt.logs.length);
  
  // Check which contracts emitted events
  const contractsInvolved = new Set();
  for (const log of receipt.logs) {
    contractsInvolved.add(log.address);
  }
  console.log("\nContracts involved:");
  for (const c of contractsInvolved) {
    if (c.toLowerCase() === PER_TOKEN_LOCKER.toLowerCase()) console.log("  Per-Token Locker:", c);
    else if (c.toLowerCase() === HOOK.toLowerCase()) console.log("  Hook:", c);
    else console.log("  ", c);
  }
  
  // Check if this is a swap that triggers collectRewardsWithoutUnlock
  // The hook's afterSwap calls collectRewardsWithoutUnlock on the locker
  // So swaps on Clanker V4 pools automatically trigger fee collection
  
  // Now let's simulate calling collectRewards directly for a high-value token
  // Token 0x59D916... has lots of swap activity
  const TOKEN = "0x59D916075b3F4DCd4121E4AD2Fb79fF7E8677b07";
  
  // Check its reward info
  const iface = new ethers.Interface([
    "function tokenRewards(address) view returns (tuple(address token, tuple(address,address,uint24,int24,address) poolKey, uint256 positionId, uint256 numPositions, uint16[] rewardBps, address[] rewardAdmins, address[] rewardRecipients))",
    "function feePreferences(address, uint256) view returns (uint8)",
    "function collectRewards(address)"
  ]);
  
  const r = await provider.call({
    to: PER_TOKEN_LOCKER,
    data: iface.encodeFunctionData("tokenRewards", [TOKEN])
  });
  const decoded = iface.decodeFunctionResult("tokenRewards", r);
  const info = decoded[0];
  console.log("\n=== TOKEN 0x59D916... REWARD INFO ===");
  console.log("Position ID:", info.positionId.toString());
  console.log("Num Positions:", info.numPositions.toString());
  console.log("Reward BPS:", info.rewardBps.map(b => b.toString()));
  console.log("Reward Admins:", info.rewardAdmins);
  console.log("Reward Recipients:", info.rewardRecipients);
  console.log("Pool Key:");
  console.log("  Currency0:", info.poolKey[0]);
  console.log("  Currency1:", info.poolKey[1]);
  console.log("  Fee:", info.poolKey[2].toString());
  console.log("  TickSpacing:", info.poolKey[3].toString());
  console.log("  Hooks:", info.poolKey[4]);
  
  // Check fee preferences for each recipient
  for (let i = 0; i < Number(info.rewardBps.length); i++) {
    const fp = await provider.call({
      to: PER_TOKEN_LOCKER,
      data: iface.encodeFunctionData("feePreferences", [TOKEN, i])
    });
    const val = Number(BigInt(fp));
    console.log(`  Recipient[${i}] fee preference:`, ["Both", "Paired", "Clanker"][val] || val);
  }
  
  // Simulate calling collectRewards to see if it would succeed
  // and what the intermediate swap would look like
  console.log("\n=== SIMULATE collectRewards ===");
  try {
    const calldata = iface.encodeFunctionData("collectRewards", [TOKEN]);
    const gasEstimate = await provider.estimateGas({
      to: PER_TOKEN_LOCKER,
      data: calldata,
      from: "0x0000000000000000000000000000000000000001" // arbitrary caller
    });
    console.log("collectRewards gas estimate:", gasEstimate.toString());
    console.log("CONFIRMED: collectRewards is callable by anyone");
  } catch (e) {
    console.log("collectRewards simulation:", e.message.slice(0, 200));
  }
}

main().catch(console.error);
