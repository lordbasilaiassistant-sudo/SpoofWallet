const { ethers } = require("ethers");

const provider = new ethers.JsonRpcProvider("https://mainnet.base.org");

const GLOBAL_FEE_LOCKER = "0xF3622742b1E446D92e45E22923Ef11C2fcD55D68";

async function main() {
  // Get creation block of fee locker from recent basescan API
  // Instead, search for AddDepositor events in chunks
  
  const feeLockerIface = new ethers.Interface([
    "event AddDepositor(address indexed depositor)"
  ]);
  const topic = feeLockerIface.getEvent("AddDepositor").topicHash;
  
  const latestBlock = await provider.getBlockNumber();
  
  // Search in 10000 block chunks, starting from a reasonable starting block
  // Clanker V4 launched around Q1 2025, so maybe block 20M+
  // Base is at ~46M now, let's try backwards from recent
  const chunks = [
    [latestBlock - 10000, latestBlock],
    [latestBlock - 100000, latestBlock - 90000],
    [latestBlock - 500000, latestBlock - 490000],
    [latestBlock - 1000000, latestBlock - 990000],
    [latestBlock - 2000000, latestBlock - 1990000],
    [latestBlock - 5000000, latestBlock - 4990000],
    [latestBlock - 10000000, latestBlock - 9990000],
    [latestBlock - 15000000, latestBlock - 14990000],
    [latestBlock - 20000000, latestBlock - 19990000],
  ];
  
  // Actually, let me try the basescan API to get the contract creation tx
  // Then search from there
  const BASESCAN_API_KEY = "REAGIMEAPZ25INJZTVGEWXC48JEZZEQGFQ";
  
  // Use basescan API to get internal txs / creation info
  const fetch = (await import('node-fetch')).default;
  
  // Get contract creation tx
  const url = `https://api.basescan.org/api?module=contract&action=getcontractcreation&contractaddresses=${GLOBAL_FEE_LOCKER}&apikey=${BASESCAN_API_KEY}`;
  const resp = await fetch(url);
  const data = await resp.json();
  console.log("Fee Locker creation info:", JSON.stringify(data.result, null, 2));
  
  if (data.result && data.result[0]) {
    const creationTx = data.result[0].txHash;
    const receipt = await provider.getTransactionReceipt(creationTx);
    console.log("Creation block:", receipt.blockNumber);
    
    // Now search for AddDepositor events from creation
    const startBlock = receipt.blockNumber;
    const logs = await provider.getLogs({
      address: GLOBAL_FEE_LOCKER,
      topics: [topic],
      fromBlock: startBlock,
      toBlock: startBlock + 10000
    });
    console.log("\nAddDepositor events near creation:", logs.length);
    for (const log of logs) {
      const parsed = feeLockerIface.parseLog(log);
      console.log("  Depositor:", parsed.args[0], "Block:", log.blockNumber);
    }
    
    // Search more recent blocks too
    const logs2 = await provider.getLogs({
      address: GLOBAL_FEE_LOCKER,
      topics: [topic],
      fromBlock: startBlock + 10000,
      toBlock: Math.min(startBlock + 100000, latestBlock)
    });
    console.log("\nAddDepositor events (creation+10k to creation+100k):", logs2.length);
    for (const log of logs2) {
      const parsed = feeLockerIface.parseLog(log);
      console.log("  Depositor:", parsed.args[0], "Block:", log.blockNumber);
    }
  }
}

main().catch(console.error);
