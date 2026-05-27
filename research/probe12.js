const { ethers } = require("ethers");
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const provider = new ethers.JsonRpcProvider("https://mainnet.base.org");
const GLOBAL_FEE_LOCKER = "0xF3622742b1E446D92e45E22923Ef11C2fcD55D68";
const PER_TOKEN_LOCKER = "0x63D2DfEA64b3433F4071A98665bcD7Ca14d93496";
const BASESCAN_API_KEY = "REAGIMEAPZ25INJZTVGEWXC48JEZZEQGFQ";

async function main() {
  // Use V2 API
  const url = `https://api.basescan.org/v2/api?chainid=8453&module=contract&action=getcontractcreation&contractaddresses=${GLOBAL_FEE_LOCKER}&apikey=${BASESCAN_API_KEY}`;
  const resp = await fetch(url);
  const data = await resp.json();
  console.log("Fee Locker creation:", JSON.stringify(data, null, 2));
  
  // Also check per-token locker
  const url2 = `https://api.basescan.org/v2/api?chainid=8453&module=contract&action=getcontractcreation&contractaddresses=${PER_TOKEN_LOCKER}&apikey=${BASESCAN_API_KEY}`;
  const resp2 = await fetch(url2);
  const data2 = await resp2.json();
  console.log("\nPer-Token Locker creation:", JSON.stringify(data2, null, 2));
  
  // If we can get the creation tx, find the block
  if (data.result && data.result[0]) {
    const txHash = data.result[0].txHash;
    console.log("\nFee Locker creation tx:", txHash);
    const receipt = await provider.getTransactionReceipt(txHash);
    console.log("Creation block:", receipt.blockNumber);
    
    // Search for AddDepositor from there
    const topic = ethers.id("AddDepositor(address)");
    const logs = await provider.getLogs({
      address: GLOBAL_FEE_LOCKER,
      topics: [topic],
      fromBlock: receipt.blockNumber,
      toBlock: receipt.blockNumber + 10000
    });
    console.log("\nAddDepositor events:", logs.length);
    const feeLockerIface = new ethers.Interface([
      "event AddDepositor(address indexed depositor)"
    ]);
    for (const log of logs) {
      const parsed = feeLockerIface.parseLog(log);
      console.log("  Depositor:", parsed.args[0], "Block:", log.blockNumber);
    }
  }
}

main().catch(console.error);
