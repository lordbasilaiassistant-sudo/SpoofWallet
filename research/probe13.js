const { ethers } = require("ethers");

const provider = new ethers.JsonRpcProvider("https://mainnet.base.org");
const GLOBAL_FEE_LOCKER = "0xF3622742b1E446D92e45E22923Ef11C2fcD55D68";

async function main() {
  const latestBlock = await provider.getBlockNumber();
  const topic = ethers.id("AddDepositor(address)");
  const feeLockerIface = new ethers.Interface([
    "event AddDepositor(address indexed depositor)"
  ]);
  
  // Search backwards in 10k chunks to find all AddDepositor events
  // Start from latest and go back
  let allDepositors = [];
  let endBlock = latestBlock;
  
  for (let i = 0; i < 5; i++) {
    const startBlock = endBlock - 10000;
    try {
      const logs = await provider.getLogs({
        address: GLOBAL_FEE_LOCKER,
        topics: [topic],
        fromBlock: startBlock,
        toBlock: endBlock
      });
      for (const log of logs) {
        const parsed = feeLockerIface.parseLog(log);
        allDepositors.push({ depositor: parsed.args[0], block: log.blockNumber });
      }
    } catch {}
    endBlock = startBlock;
  }
  
  // Also search further back - the contract was likely deployed months ago
  // Try blocks around 30M-40M range 
  const ranges = [
    [40000000, 40010000],
    [38000000, 38010000],
    [36000000, 36010000],
    [34000000, 34010000],
    [32000000, 32010000],
    [30000000, 30010000],
    [28000000, 28010000],
    [26000000, 26010000],
    [24000000, 24010000],
    [22000000, 22010000],
    [20000000, 20010000],
  ];
  
  for (const [start, end] of ranges) {
    try {
      const logs = await provider.getLogs({
        address: GLOBAL_FEE_LOCKER,
        topics: [topic],
        fromBlock: start,
        toBlock: end
      });
      for (const log of logs) {
        const parsed = feeLockerIface.parseLog(log);
        allDepositors.push({ depositor: parsed.args[0], block: log.blockNumber });
      }
    } catch {}
  }
  
  // Let me also try to get the contract code size at various blocks to find deployment
  // Check if the contract exists at block 25M
  const codeLen = async (block) => {
    try {
      const code = await provider.getCode(GLOBAL_FEE_LOCKER, block);
      return code.length > 2; // "0x" means no code
    } catch { return false; }
  };
  
  // Binary search for deployment block
  let lo = 20000000, hi = latestBlock;
  // First check if it exists at lo
  const existsAtLo = await codeLen(lo);
  console.log(`Code exists at block ${lo}:`, existsAtLo);
  
  if (!existsAtLo) {
    // Binary search
    while (hi - lo > 10000) {
      const mid = Math.floor((lo + hi) / 2);
      const exists = await codeLen(mid);
      if (exists) {
        hi = mid;
      } else {
        lo = mid;
      }
    }
    console.log(`Contract deployed between blocks ${lo} and ${hi}`);
    
    // Search for AddDepositor in that range
    try {
      const logs = await provider.getLogs({
        address: GLOBAL_FEE_LOCKER,
        topics: [topic],
        fromBlock: lo,
        toBlock: hi
      });
      for (const log of logs) {
        const parsed = feeLockerIface.parseLog(log);
        allDepositors.push({ depositor: parsed.args[0], block: log.blockNumber });
      }
    } catch {}
  }
  
  console.log("\n=== ALL FOUND DEPOSITORS ===");
  // Dedupe
  const unique = [...new Set(allDepositors.map(d => d.depositor))];
  for (const d of unique) {
    const entry = allDepositors.find(e => e.depositor === d);
    console.log("  Depositor:", d, "Block:", entry.block);
  }
  console.log("Total unique depositors found:", unique.length);
}

main().catch(console.error);
