const { ethers } = require("ethers");

const RPC = "https://mainnet.base.org";
const provider = new ethers.JsonRpcProvider(RPC);

const GLOBAL_FEE_LOCKER = "0xF3622742b1E446D92e45E22923Ef11C2fcD55D68";
const PER_TOKEN_LOCKER = "0x63D2DfEA64b3433F4071A98665bcD7Ca14d93496";
const FACTORY = "0xE85A59c628F7d27878ACeB4bf3b35733630083a9";
const HOOK = "0xDd5EeaFf7BD481AD55Db083062b13a3cdf0A68CC";
const WETH = "0x4200000000000000000000000000000000000006";
const BURNOUT_TOKEN = "0xE0A048281bF0dA1A24F360e6a3129959FdAA8b07";

async function main() {
  console.log("=== GLOBAL FEE LOCKER STATE ===");
  
  // Owner
  const feeLockerOwnerSig = "0x8da5cb5b"; // owner()
  let result = await provider.call({ to: GLOBAL_FEE_LOCKER, data: feeLockerOwnerSig });
  console.log("Fee Locker Owner:", ethers.getAddress("0x" + result.slice(26)));
  
  // Check if per-token locker is an allowed depositor
  const allowedDepositorSig = ethers.id("allowedDepositors(address)").slice(0, 10);
  result = await provider.call({ 
    to: GLOBAL_FEE_LOCKER, 
    data: allowedDepositorSig + ethers.zeroPadValue(PER_TOKEN_LOCKER, 32).slice(2)
  });
  console.log("Per-Token Locker is allowed depositor:", result !== "0x" + "0".repeat(64));
  
  // Check if factory is allowed depositor
  result = await provider.call({
    to: GLOBAL_FEE_LOCKER,
    data: allowedDepositorSig + ethers.zeroPadValue(FACTORY, 32).slice(2)
  });
  console.log("Factory is allowed depositor:", result !== "0x" + "0".repeat(64));

  console.log("\n=== FACTORY STATE ===");
  // Factory owner
  result = await provider.call({ to: FACTORY, data: feeLockerOwnerSig });
  console.log("Factory Owner:", ethers.getAddress("0x" + result.slice(26)));
  
  // Check deprecated
  const deprecatedSig = ethers.id("deprecated()").slice(0, 10);
  result = await provider.call({ to: FACTORY, data: deprecatedSig });
  console.log("Factory deprecated:", result !== "0x" + "0".repeat(64));
  
  // Team fee recipient
  const teamFeeSig = ethers.id("teamFeeRecipient()").slice(0, 10);
  result = await provider.call({ to: FACTORY, data: teamFeeSig });
  console.log("Team fee recipient:", ethers.getAddress("0x" + result.slice(26)));

  console.log("\n=== PER-TOKEN LOCKER STATE ===");
  // Owner
  result = await provider.call({ to: PER_TOKEN_LOCKER, data: feeLockerOwnerSig });
  console.log("Per-Token Locker Owner:", ethers.getAddress("0x" + result.slice(26)));
  
  // Factory immutable
  const factorySig = ethers.id("factory()").slice(0, 10);
  result = await provider.call({ to: PER_TOKEN_LOCKER, data: factorySig });
  console.log("Per-Token Locker Factory:", ethers.getAddress("0x" + result.slice(26)));
  
  // Fee locker immutable
  const feeLockerSig = ethers.id("feeLocker()").slice(0, 10);
  result = await provider.call({ to: PER_TOKEN_LOCKER, data: feeLockerSig });
  console.log("Per-Token Locker Fee Locker:", ethers.getAddress("0x" + result.slice(26)));

  console.log("\n=== WETH BALANCE CHECK ===");
  const balanceSig = ethers.id("balanceOf(address)").slice(0, 10);
  result = await provider.call({
    to: WETH,
    data: balanceSig + ethers.zeroPadValue(GLOBAL_FEE_LOCKER, 32).slice(2)
  });
  console.log("WETH in Global Fee Locker:", ethers.formatEther(result), "WETH");
  
  result = await provider.call({
    to: WETH,
    data: balanceSig + ethers.zeroPadValue(PER_TOKEN_LOCKER, 32).slice(2)
  });
  console.log("WETH in Per-Token Locker:", ethers.formatEther(result), "WETH");

  console.log("\n=== BURNOUT TOKEN REWARD INFO ===");
  // tokenRewards(address)
  const iface = new ethers.Interface([
    "function tokenRewards(address token) external view returns (tuple(address token, tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, uint256 positionId, uint256 numPositions, uint16[] rewardBps, address[] rewardAdmins, address[] rewardRecipients))"
  ]);
  const calldata = iface.encodeFunctionData("tokenRewards", [BURNOUT_TOKEN]);
  result = await provider.call({ to: PER_TOKEN_LOCKER, data: calldata });
  try {
    const decoded = iface.decodeFunctionResult("tokenRewards", result);
    const info = decoded[0];
    console.log("Token:", info.token);
    console.log("Position ID:", info.positionId.toString());
    console.log("Num Positions:", info.numPositions.toString());
    console.log("Reward BPS:", info.rewardBps.map(b => b.toString()));
    console.log("Reward Admins:", info.rewardAdmins);
    console.log("Reward Recipients:", info.rewardRecipients);
  } catch (e) {
    console.log("Error decoding tokenRewards:", e.message);
  }

  console.log("\n=== HOOK STATE ===");
  result = await provider.call({ to: HOOK, data: feeLockerOwnerSig });
  console.log("Hook Owner:", ethers.getAddress("0x" + result.slice(26)));
  
  // Check factory on hook
  result = await provider.call({ to: HOOK, data: factorySig });
  console.log("Hook Factory:", ethers.getAddress("0x" + result.slice(26)));
  
  // Check if locker is enabled for hook on factory
  const enabledLockersSig = ethers.id("enabledLockers(address,address)").slice(0, 10);
  result = await provider.call({
    to: FACTORY,
    data: enabledLockersSig + ethers.zeroPadValue(PER_TOKEN_LOCKER, 32).slice(2) + ethers.zeroPadValue(HOOK, 32).slice(2)
  });
  console.log("Per-Token Locker enabled for Hook:", result !== "0x" + "0".repeat(64));

  // Check available fees for various addresses
  console.log("\n=== CHECK FEE AVAILABILITY ===");
  const availableFeesSig = ethers.id("availableFees(address,address)").slice(0, 10);
  
  // Check our deployer wallet fees
  const OUR_WALLET = "0x7a3E312Ec6e20a9F62fE2405938EB9060312E334";
  result = await provider.call({
    to: GLOBAL_FEE_LOCKER,
    data: availableFeesSig + ethers.zeroPadValue(OUR_WALLET, 32).slice(2) + ethers.zeroPadValue(WETH, 32).slice(2)
  });
  console.log("Our wallet WETH fees:", ethers.formatEther(result), "WETH");
}

main().catch(console.error);
