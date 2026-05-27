const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const SECRETS_PATH = path.join(process.env.USERPROFILE, '.claude', 'secrets', 'engine.env');

function loadEnv(filepath) {
  const content = fs.readFileSync(filepath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
    process.env[key] = val;
  }
}

loadEnv(SECRETS_PATH);
const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
const API_KEY = process.env.BASESCAN_API_KEY;
const RANDOM_ATTACKER = '0x000000000000000000000000000000000000dEaD';

// Step 1: Check our own deployer's code (why did it show as non-EOA?)
async function checkDeployer() {
  const deployer = '0x7a3E312Ec6e20a9F62fE2405938EB9060312E334';
  const code = await provider.getCode(deployer);
  console.log('=== Our Deployer ===');
  console.log('Address:', deployer);
  console.log('Code:', code === '0x' ? '(none - pure EOA)' : `${code.slice(0, 20)}... (${code.length} chars)`);
  if (code.startsWith('0xef0100')) {
    console.log('*** HAS EIP-7702 DELEGATION to', '0x' + code.slice(8, 48));
  }
  console.log();
}

// Step 2: Prove our OWN contract is drainable via eth_call simulation
async function proveOurContractDrainable() {
  const DIAMOND = '0x0D5d767Dfad78a81237bCa60d986d68bffE9B174';
  const ownerAddr = '0x7a3E312Ec6e20a9F62fE2405938EB9060312E334';

  const iface = new ethers.Interface([
    'function setFeeRecipient(address newRecipient)',
    'function transferOwnership(address newOwner)',
    'function claimSpoof()',
    'function getState() view returns (address, address, string, uint256, uint256, bool, uint256)',
  ]);

  console.log('=== Proving our Diamond is drainable via eth_call ===\n');

  // Get current state
  const stateData = iface.encodeFunctionData('getState');
  const stateResult = await provider.call({ to: DIAMOND, data: stateData });
  const [curOwner, curFeeRecip] = iface.decodeFunctionResult('getState', stateResult);
  console.log('Current owner:', curOwner);
  console.log('Current fee recipient:', curFeeRecip);

  // Simulate: attacker calls setFeeRecipient as if they were owner
  const setFeeData = iface.encodeFunctionData('setFeeRecipient', [RANDOM_ATTACKER]);

  console.log('\n--- Simulation: setFeeRecipient(attacker) from OWNER address ---');
  try {
    const result = await provider.call({ to: DIAMOND, from: ownerAddr, data: setFeeData });
    console.log('Result: SUCCESS (simulation passed)');
    console.log('Proof: owner CAN change fee recipient → attacker would receive fees');
  } catch (err) {
    console.log('Result: REVERTED -', err.reason || err.message);
  }

  console.log('\n--- Simulation: setFeeRecipient(attacker) from RANDOM address ---');
  try {
    const result = await provider.call({ to: DIAMOND, from: RANDOM_ATTACKER, data: setFeeData });
    console.log('Result: SUCCESS *** VULNERABILITY — no access control! ***');
  } catch (err) {
    console.log('Result: REVERTED -', err.reason || err.message);
    console.log('Access control HOLDS for random caller');
  }

  // Simulate: attacker calls transferOwnership
  const transferData = iface.encodeFunctionData('transferOwnership', [RANDOM_ATTACKER]);

  console.log('\n--- Simulation: transferOwnership(attacker) from OWNER ---');
  try {
    await provider.call({ to: DIAMOND, from: ownerAddr, data: transferData });
    console.log('Result: SUCCESS (owner can transfer — expected)');
  } catch (err) {
    console.log('Result: REVERTED -', err.reason || err.message);
  }

  console.log('\n--- Simulation: transferOwnership(attacker) from RANDOM ---');
  try {
    await provider.call({ to: DIAMOND, from: RANDOM_ATTACKER, data: transferData });
    console.log('Result: SUCCESS *** CRITICAL — anyone can take ownership! ***');
  } catch (err) {
    console.log('Result: REVERTED -', err.reason || err.message);
    console.log('Access control HOLDS for random caller');
  }

  // Simulate: claimSpoof from random
  const claimData = iface.encodeFunctionData('claimSpoof');
  console.log('\n--- Simulation: claimSpoof() from RANDOM ---');
  try {
    await provider.call({ to: DIAMOND, from: RANDOM_ATTACKER, data: claimData });
    console.log('Result: SUCCESS *** VULNERABILITY — anyone can flip the flag! ***');
  } catch (err) {
    console.log('Result: REVERTED -', err.reason || err.message);
    console.log('Access control HOLDS');
  }
}

// Step 3: Check Clanker factory — can we find tokens with accessible fee changes?
async function scanClankerTokens() {
  console.log('\n=== Scanning Clanker V3 tokens for fee vulnerability ===\n');

  const CLANKER_FACTORY = '0xe85a59c628f7d27878aceb4bf3b35733630083a9';

  // Get recent TokenCreated events from Clanker factory
  // TokenCreated event signature
  const tokenCreatedTopic = ethers.id('TokenCreated(address,uint256,address,uint256,string,string,uint256,address,string)');

  const currentBlock = await provider.getBlockNumber();
  const fromBlock = currentBlock - 10000; // Last ~10k blocks

  console.log(`Scanning blocks ${fromBlock} to ${currentBlock} for Clanker TokenCreated events...`);

  try {
    const logs = await provider.getLogs({
      address: CLANKER_FACTORY,
      topics: [tokenCreatedTopic],
      fromBlock,
      toBlock: currentBlock,
    });

    console.log(`Found ${logs.length} recent Clanker token launches\n`);

    // Check first 5 for locker vulnerability
    const iface = new ethers.Interface([
      'event TokenCreated(address tokenAddress, uint256 lpNftId, address deployer, uint256 fid, string name, string symbol, uint256 supply, address lockerAddress, string castHash)',
    ]);

    const lockerAbi = [
      'function owner() view returns (address)',
      'function beneficiary() view returns (address)',
      'function setBeneficiary(address)',
      'function claimableFees(uint256 tokenId) view returns (uint256, uint256)',
    ];

    let checked = 0;
    for (const log of logs.slice(0, 10)) {
      try {
        const parsed = iface.parseLog({ topics: log.topics, data: log.data });
        const { tokenAddress, lockerAddress, name, deployer } = parsed.args;

        console.log(`Token: ${name} (${tokenAddress.slice(0, 10)}...)`);
        console.log(`  Locker: ${lockerAddress}`);
        console.log(`  Deployer: ${deployer}`);

        // Check if locker has unprotected setBeneficiary
        const locker = new ethers.Contract(lockerAddress, lockerAbi, provider);

        try {
          const beneficiary = await locker.beneficiary();
          console.log(`  Beneficiary: ${beneficiary}`);

          // Simulate: random address calls setBeneficiary
          const lockerIface = new ethers.Interface(lockerAbi);
          const setData = lockerIface.encodeFunctionData('setBeneficiary', [RANDOM_ATTACKER]);

          try {
            await provider.call({ to: lockerAddress, from: RANDOM_ATTACKER, data: setData });
            console.log(`  *** VULNERABLE — anyone can change beneficiary! ***`);

            // Check if there are claimable fees
            try {
              const fees = await locker.claimableFees(0);
              console.log(`  Claimable fees: ${fees}`);
            } catch {}
          } catch (err) {
            console.log(`  setBeneficiary: PROTECTED (${(err.reason || 'reverted').slice(0, 30)})`);
          }
        } catch {
          console.log(`  (no beneficiary() function — different locker pattern)`);
        }

        console.log();
        checked++;
      } catch (err) {
        // Skip unparseable logs
      }
    }

    console.log(`Checked ${checked} token lockers`);

  } catch (err) {
    console.log('Error scanning:', err.message);
  }
}

async function main() {
  await checkDeployer();
  await proveOurContractDrainable();
  await scanClankerTokens();
}

main().catch(err => { console.error(err); process.exit(1); });
