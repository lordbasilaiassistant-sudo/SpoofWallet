const { ethers } = require("ethers");

const provider = new ethers.JsonRpcProvider("https://mainnet.base.org");
const GLOBAL_FEE_LOCKER = "0xF3622742b1E446D92e45E22923Ef11C2fcD55D68";
const PER_TOKEN_LOCKER = "0x63D2DfEA64b3433F4071A98665bcD7Ca14d93496";
const OLD_DEPOSITOR = "0x29d17C1A8D851d7d4cA97FAe97AcAdb398D9cCE0";

async function main() {
  // Confirm: is the old depositor different from current per-token locker?
  console.log("PER_TOKEN_LOCKER:", PER_TOKEN_LOCKER);
  console.log("OLD_DEPOSITOR:", OLD_DEPOSITOR);
  console.log("Are they different?", PER_TOKEN_LOCKER !== OLD_DEPOSITOR);
  
  // Check: is PER_TOKEN_LOCKER actually an allowed depositor?
  const adSig = ethers.id("allowedDepositors(address)").slice(0, 10);
  
  let r = await provider.call({
    to: GLOBAL_FEE_LOCKER,
    data: adSig + ethers.zeroPadValue(PER_TOKEN_LOCKER, 32).slice(2)
  });
  console.log("\nPER_TOKEN_LOCKER is allowed depositor:", BigInt(r) !== 0n);
  
  r = await provider.call({
    to: GLOBAL_FEE_LOCKER,
    data: adSig + ethers.zeroPadValue(OLD_DEPOSITOR, 32).slice(2)
  });
  console.log("OLD_DEPOSITOR is allowed depositor:", BigInt(r) !== 0n);
  
  // So we found the initial depositor. There might be more added later.
  // Search for AddDepositor events between deployment and latest
  const latestBlock = await provider.getBlockNumber();
  const topic = ethers.id("AddDepositor(address)");
  const iface = new ethers.Interface(["event AddDepositor(address indexed depositor)"]);
  
  // Search in chunks of 10000
  let allDepositors = [];
  for (let start = 31522000; start < latestBlock; start += 10000) {
    const end = Math.min(start + 10000, latestBlock);
    try {
      const logs = await provider.getLogs({
        address: GLOBAL_FEE_LOCKER,
        topics: [topic],
        fromBlock: start,
        toBlock: end
      });
      for (const log of logs) {
        const parsed = iface.parseLog(log);
        allDepositors.push({ depositor: parsed.args[0], block: log.blockNumber });
      }
    } catch (e) {
      // skip failed chunks
    }
    // Be respectful of rate limits
    if ((start - 31522000) % 100000 === 0 && start !== 31522000) {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  
  console.log("\nAll AddDepositor events found:", allDepositors.length);
  const unique = new Map();
  for (const d of allDepositors) {
    if (!unique.has(d.depositor)) unique.set(d.depositor, d.block);
  }
  for (const [dep, block] of unique) {
    console.log("  Depositor:", dep, "Block:", block);
  }
  
  // Check if the old depositor is a locker contract
  // What's its feeLocker?
  const feeLockerSig = ethers.id("feeLocker()").slice(0, 10);
  try {
    r = await provider.call({ to: OLD_DEPOSITOR, data: feeLockerSig });
    console.log("\nOld depositor feeLocker():", ethers.getAddress("0x" + r.slice(26)));
  } catch (e) {
    console.log("\nOld depositor feeLocker() failed:", e.message.slice(0, 100));
  }
  
  // Check factory
  const factorySig = ethers.id("factory()").slice(0, 10);
  try {
    r = await provider.call({ to: OLD_DEPOSITOR, data: factorySig });
    console.log("Old depositor factory():", ethers.getAddress("0x" + r.slice(26)));
  } catch {}
  
  // Check owner
  const ownerSig = ethers.id("owner()").slice(0, 10);
  try {
    r = await provider.call({ to: OLD_DEPOSITOR, data: ownerSig });
    console.log("Old depositor owner():", ethers.getAddress("0x" + r.slice(26)));
  } catch {}
}

main().catch(console.error);
