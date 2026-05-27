#!/usr/bin/env node
// Fee monitor — checks all our deployed tokens for claimable fees
// Adapted from CheckClankrFees backend logic
// Run periodically to catch any token generating revenue

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const RPC_ENDPOINTS = [
  'https://mainnet.base.org',
  'https://base-rpc.publicnode.com',
  'https://base.drpc.org',
  'https://1rpc.io/base',
  'https://rpc.ankr.com/base',
];

let rpcIndex = 0;
function getProvider() {
  const url = RPC_ENDPOINTS[rpcIndex % RPC_ENDPOINTS.length];
  rpcIndex++;
  return new ethers.JsonRpcProvider(url);
}

const FL = '0xF3622742b1E446D92e45E22923Ef11C2fcD55D68';
const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const AUDITOR = '0x3B734682625aCCB800c4e18cF8a10380505b945e';
const TREASURY = '0x7a3E312Ec6e20a9F62fE2405938EB9060312E334';

// All our deployed tokens
const TOKENS = [
  // Auditor wallet tokens
  { sym: 'OCEAN', addr: '0xAf3AfFd29256aE9C6794CF35fddBaB92631f04A8', wallet: AUDITOR },
  { sym: 'REMEMBER', addr: '0x099FAD1f591ed00dB74042AA6226830d928e03C0', wallet: AUDITOR },
  { sym: 'EID', addr: '0xE340207FDd4D6067340C81EAE958687dB8583c8A', wallet: AUDITOR },
  { sym: 'BASEDAI', addr: '0xc73484AFaCe2c2bc58df027864F1736801A7a75B', wallet: AUDITOR },
  { sym: 'SAFE', addr: '0xeBBAA7fB3f0042D5ee319D5CB4599044D7EeC681', wallet: AUDITOR },
  { sym: 'PEACE', addr: '0xD7B3c1672f49e050B4b83D09ACBb174E9f95794f', wallet: AUDITOR },
  { sym: 'CAVS', addr: '0xD45FE8A42E66B6e5C9b396D05A687F0BDBB20540', wallet: AUDITOR },
  { sym: 'TRUMP26', addr: '0x59eCC2f83Cc4174F2cb08034E639611303147733', wallet: AUDITOR },
  { sym: 'WEMBY', addr: '0x1486aa5898c5692a43A85547DD41598159E36fF9', wallet: AUDITOR },
  { sym: 'JUSTICE', addr: '0xfbf61BC607c3767bAE78646D7B06b87898426Dd1', wallet: AUDITOR },
  { sym: 'FREE', addr: '0x588BeD7C1C8aEFeAE600bEEd95f76e96E233d077', wallet: AUDITOR },
  { sym: 'GUNNER', addr: '0xa95d1FE26D3886d3fF2E0D7905FEAcD70F9a5098', wallet: AUDITOR },
  { sym: 'DROP', addr: '0x3482A76eB9302dC01eb8E45Fcb72552a8878fd9F', wallet: AUDITOR },
  { sym: 'ARMY', addr: '0x106c60F8368d47a137e244C7409BC1037E6aEeeB', wallet: AUDITOR },
  { sym: 'YPLT', addr: '0x73F537DF092964005d03F7345787daD4A2B54E37', wallet: AUDITOR },
  { sym: 'SWARM', addr: '0x3107EA5D9eA2703EC6b58AD0888C196f6122a330', wallet: AUDITOR },
  { sym: 'GASAI', addr: '0x9BF818729079400684533Be1e37535D60313f8aF', wallet: AUDITOR },
  { sym: 'NXVLT-1', addr: '0xAE8eabc8919308A39Cf607eFa7129e9B0422FB07', wallet: AUDITOR },
  { sym: 'NXVLT-2', addr: '0x041908241F72Ee5Fbd0F9Ce0eb56d2F652d4Db07', wallet: AUDITOR },
  // Treasury wallet tokens
  { sym: 'burnout', addr: '0xE0A048281bF0dA1A24F360e6a3129959FdAA8b07', wallet: TREASURY },
];

async function checkFees() {
  const p = getProvider();
  const fl = new ethers.Contract(FL, ['function availableFees(address,address) view returns (uint256)'], p);
  const block = await p.getBlockNumber();
  const xferTopic = ethers.id('Transfer(address,address,uint256)');

  console.log('=== FEE MONITOR ===');
  console.log('Timestamp:', new Date().toISOString());
  console.log('Block:', block);
  console.log('');

  let totalWethFees = 0n;
  let totalUsdcFees = 0n;
  let tokensWithTrades = 0;

  for (const token of TOKENS) {
    try {
      // Check transfers
      const logs = await p.getLogs({ address: token.addr, topics: [xferTopic], fromBlock: block - 5000, toBlock: 'latest' });
      const trades = logs.length > 3 ? logs.length - 3 : 0;

      // Check WETH fees
      const wethFees = await fl.availableFees(token.wallet, WETH);
      const usdcFees = await fl.availableFees(token.wallet, USDC);

      if (trades > 0 || wethFees > 0n || usdcFees > 0n) {
        console.log('*** ' + token.sym + ' ***');
        if (trades > 0) console.log('  TRADES:', trades);
        if (wethFees > 0n) console.log('  WETH fees:', ethers.formatEther(wethFees));
        if (usdcFees > 0n) console.log('  USDC fees:', ethers.formatUnits(usdcFees, 6));
        console.log('  ' + token.addr);
        tokensWithTrades++;
      }

      totalWethFees += wethFees;
      totalUsdcFees += usdcFees;
    } catch (e) {
      // Skip errors, try next RPC
    }
    await new Promise(r => setTimeout(r, 100));
  }

  console.log('');
  console.log('Tokens with activity:', tokensWithTrades, '/', TOKENS.length);
  console.log('Total WETH fees:', ethers.formatEther(totalWethFees));
  console.log('Total USDC fees:', ethers.formatUnits(totalUsdcFees, 6));
  console.log('Auditor ETH:', ethers.formatEther(await p.getBalance(AUDITOR)));
  console.log('Treasury ETH:', ethers.formatEther(await p.getBalance(TREASURY)));
}

checkFees().catch(e => console.error(e.message?.slice(0, 100)));
