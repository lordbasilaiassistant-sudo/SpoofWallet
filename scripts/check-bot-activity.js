const { ethers } = require('ethers');
const p = new ethers.JsonRpcProvider('https://base-rpc.publicnode.com');

const FACTORY = '0xE85A59c628F7d27878ACeB4bf3b35733630083a9';

async function main() {
  const block = await p.getBlockNumber();
  const topic = ethers.id('TokenCreated(address,uint256,address,uint256,string,string,uint256,address,string)');

  const logs = await p.getLogs({
    address: FACTORY,
    topics: [topic],
    fromBlock: block - 500,
    toBlock: block,
  });

  console.log('Timestamp:', new Date().toISOString());
  console.log('Clanker deploys last 500 blocks:', logs.length);

  const transferTopic = ethers.id('Transfer(address,address,uint256)');
  let traded = 0;

  for (const log of logs.slice(-8)) {
    const addr = '0x' + log.topics[1].slice(26);
    try {
      const xfers = await p.getLogs({
        address: addr,
        topics: [transferTopic],
        fromBlock: log.blockNumber,
        toBlock: block,
      });
      const hasTrades = xfers.length > 5;
      if (hasTrades) traded++;
      console.log(addr.slice(0, 12) + '.. block:' + log.blockNumber + ' transfers:' + xfers.length + (hasTrades ? ' TRADED' : ''));
    } catch (e) {}
    await new Promise(r => setTimeout(r, 300));
  }

  console.log('');
  console.log(traded + '/' + Math.min(logs.length, 8) + ' recent tokens got bot activity');
}

main();
