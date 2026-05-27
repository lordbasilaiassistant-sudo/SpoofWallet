const { ethers } = require("ethers");

const provider = new ethers.JsonRpcProvider("https://mainnet.base.org");

const PER_TOKEN_LOCKER = "0x63D2DfEA64b3433F4071A98665bcD7Ca14d93496";
const GLOBAL_FEE_LOCKER = "0xF3622742b1E446D92e45E22923Ef11C2fcD55D68";
const WETH = "0x4200000000000000000000000000000000000006";
const POSITION_MANAGER = "0x7C5f5A4bBd8fD63184577525326123B519429bDc"; // Uniswap V4 posm on Base

async function main() {
  // ATTACK VECTOR: ERC721 position theft
  // The locker holds LP position NFTs. Can we make it transfer them out?
  
  // Check if the position manager has an `approve` that the locker called
  // If the locker ever approved someone to manage its positions...
  
  // Check: does the locker approve the position manager for all NFTs?
  // The modifyLiquidities call in _bringFeesIntoContract doesn't need approval
  // because the locker IS the owner of the position
  
  console.log("=== POSITION NFT SECURITY ===");
  
  // Check isApprovedForAll on positionManager
  const isApprovedSig = ethers.id("isApprovedForAll(address,address)").slice(0, 10);
  
  // Did the locker approve the factory?
  let r = await provider.call({
    to: POSITION_MANAGER,
    data: isApprovedSig + 
      ethers.zeroPadValue(PER_TOKEN_LOCKER, 32).slice(2) + 
      ethers.zeroPadValue("0xE85A59c628F7d27878ACeB4bf3b35733630083a9", 32).slice(2) // factory
  });
  console.log("Locker approved factory for NFTs:", BigInt(r) !== 0n);
  
  // Did the locker approve the owner?
  r = await provider.call({
    to: POSITION_MANAGER,
    data: isApprovedSig + 
      ethers.zeroPadValue(PER_TOKEN_LOCKER, 32).slice(2) + 
      ethers.zeroPadValue("0xEea96d959963EaB488A3d4B7d5d347785cf1Eab8", 32).slice(2) // owner
  });
  console.log("Locker approved owner for NFTs:", BigInt(r) !== 0n);

  // Did the locker approve the universal router?
  const UNIVERSAL_ROUTER = "0xd0a40c6526acdEbd4f6D87931098FF37A9f8E4Bf";
  r = await provider.call({
    to: POSITION_MANAGER,
    data: isApprovedSig + 
      ethers.zeroPadValue(PER_TOKEN_LOCKER, 32).slice(2) + 
      ethers.zeroPadValue(UNIVERSAL_ROUTER, 32).slice(2)
  });
  console.log("Locker approved universal router for NFTs:", BigInt(r) !== 0n);

  // ATTACK VECTOR: The locker's withdrawERC20 could drain WETH held temporarily
  // During fee collection, the locker briefly holds WETH (from V4 fee claim)
  // before forwarding it to the fee locker via storeFees
  // If the owner calls withdrawERC20 during this window...
  // But that's a trusted role, not an external attack
  console.log("\n=== TEMPORAL TOKEN HOLDING ===");
  console.log("During _collectRewards, the locker temporarily holds fee tokens");
  console.log("  1. _bringFeesIntoContract: V4 fees -> locker balance");
  console.log("  2. _handleFees: locker balance -> fee locker (via storeFees)");
  console.log("Between steps 1 and 2, the locker holds the WETH/clanker tokens");
  console.log("If withdrawERC20 is called during this window, tokens are stolen");
  console.log("But withdrawERC20 is onlyOwner - trusted party only");
  console.log("NOT exploitable by external attacker");

  // ATTACK VECTOR: Deploy a token that has fee-on-transfer
  // The factory deploys ClankerToken which doesn't have fee-on-transfer
  // But what about the fee conversion swap? The clanker token is standard ERC20
  // The paired token (WETH) is also standard
  // No fee-on-transfer exploit possible
  
  // ATTACK VECTOR: Integer overflow/underflow
  // Solidity 0.8.28 has built-in overflow checks
  // The only unchecked operation is in balance deltas from V4
  // BalanceDelta uses int128 which can overflow at very large amounts
  // But the actual amounts are bounded by pool liquidity
  console.log("\n=== OVERFLOW ANALYSIS ===");
  console.log("Solidity 0.8.28 - built-in overflow protection");
  console.log("uint128 casts in _uniSwapLocked/Unlocked:");
  console.log("  uint128(tokenToSwap) - if tokenToSwap > 2^128, this truncates");
  console.log("  tokenToSwap = amount minus distributed portions");
  console.log("  Maximum amount = pool's total collected fees");
  console.log("  Would need > 340B WETH in a single collection to overflow");
  console.log("  NOT practically exploitable");

  // ATTACK VECTOR: The fee locker uses balance deltas (balanceAfter - balanceBefore)
  // in storeFees. What if we donate tokens to the fee locker during the transfer?
  // This would increase receivedAmount beyond what was actually sent
  // But: storeFees uses safeTransferFrom which is atomic
  // The donation would need to happen IN the same transfer, which isn't possible
  // for standard ERC20
  console.log("\n=== BALANCE DELTA MANIPULATION ===");
  console.log("storeFees uses balanceAfter - balanceBefore");
  console.log("Could donation between before/after inflate the amount?");
  console.log("The transfer is atomic (safeTransferFrom) - no window for donation");
  console.log("For standard ERC20: BLOCKED");
  console.log("For fee-on-transfer tokens: the delta correctly accounts for it");
  console.log("For rebasing tokens: delta changes would affect ALL depositors equally");

  // ATTACK VECTOR: What if two lockers are depositors for the same fee locker?
  // and one of them has a vulnerability?
  // Check how many allowed depositors exist
  const adSig = ethers.id("allowedDepositors(address)").slice(0, 10);
  
  // Check a few other known/likely lockers
  const candidates = [
    "0x616ed48C2F8D07A84c23a2eBE23FB5f2D8B66b72",
    PER_TOKEN_LOCKER,
    "0x63D2DfEA64b3433F4071A98665bcD7Ca14d93496", // same as PER_TOKEN_LOCKER
  ];
  
  // Also: can we find other depositors by scanning AddDepositor events?
  const feeLockerIface = new ethers.Interface([
    "event AddDepositor(address indexed depositor)"
  ]);
  
  try {
    const addDepositortopic = feeLockerIface.getEvent("AddDepositor").topicHash;
    const logs = await provider.getLogs({
      address: GLOBAL_FEE_LOCKER,
      topics: [addDepositortopic],
      fromBlock: 0,
      toBlock: "latest"
    });
    console.log("\n=== ALL ALLOWED DEPOSITORS (from events) ===");
    console.log("AddDepositor events found:", logs.length);
    for (const log of logs) {
      const parsed = feeLockerIface.parseLog(log);
      console.log("  Depositor:", parsed.args[0], "Block:", log.blockNumber);
    }
  } catch (e) {
    console.log("AddDepositor scan error:", e.message.slice(0, 200));
  }

  // Check the total WETH locked across the system
  const balSig = ethers.id("balanceOf(address)").slice(0, 10);
  r = await provider.call({
    to: WETH,
    data: balSig + ethers.zeroPadValue(GLOBAL_FEE_LOCKER, 32).slice(2)
  });
  console.log("\n=== TOTAL VALUE IN SYSTEM ===");
  console.log("WETH in Global Fee Locker:", ethers.formatEther(r));
}

main().catch(console.error);
