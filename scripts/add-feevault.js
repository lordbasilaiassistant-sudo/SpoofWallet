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

function loadArtifact(name) {
  return JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '..', 'artifacts', 'diamond', `${name}.json`), 'utf8'
  ));
}

function getSelectors(abi) {
  const iface = new ethers.Interface(abi);
  return iface.fragments
    .filter(f => f.type === 'function')
    .map(f => iface.getFunction(f.name).selector);
}

async function main() {
  loadEnv(SECRETS_PATH);
  const pk = process.env.THRYXTREASURY_PRIVATE_KEY;
  const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
  const wallet = new ethers.Wallet(pk, provider);

  const DIAMOND = '0x0D5d767Dfad78a81237bCa60d986d68bffE9B174';
  const cutAbi = loadArtifact('DiamondCutFacet').abi;
  const vaultArtifact = loadArtifact('FeeVaultFacet');

  console.log('Deployer:', wallet.address);

  console.log('\n--- Deploying FeeVaultFacet ---');
  const factory = new ethers.ContractFactory(vaultArtifact.abi, vaultArtifact.bytecode, wallet);
  const facet = await factory.deploy();
  await facet.waitForDeployment();
  const facetAddr = await facet.getAddress();
  console.log('FeeVaultFacet:', facetAddr);

  const sels = getSelectors(vaultArtifact.abi);
  console.log('Selectors:', sels);

  await new Promise(r => setTimeout(r, 5000));

  console.log('\n--- Adding to Diamond ---');
  const diamond = new ethers.Contract(DIAMOND, cutAbi, wallet);
  let tx = await diamond.diamondCut(facetAddr, sels, 0); // Add
  await tx.wait();
  console.log('Added:', tx.hash);

  await new Promise(r => setTimeout(r, 5000));

  // Initialize: 2.5% fee rate, 80% LP fees to recipient, 60 second timelock
  console.log('\n--- Initializing Vault ---');
  const vaultContract = new ethers.Contract(DIAMOND, vaultArtifact.abi, wallet);
  tx = await vaultContract.initializeVault(250, 8000, 60);
  await tx.wait();
  console.log('Vault initialized:', tx.hash);

  // Deposit some SPOOF tokens as simulated trading fees
  const erc20Abi = loadArtifact('ERC20Facet').abi;
  const tokenContract = new ethers.Contract(DIAMOND, erc20Abi, wallet);

  await new Promise(r => setTimeout(r, 5000));

  const depositAmount = ethers.parseEther('10000'); // 10K SPOOF as accumulated fees
  console.log('\n--- Depositing 10K SPOOF as simulated fees ---');
  tx = await vaultContract.depositFees(depositAmount);
  await tx.wait();
  console.log('Deposited:', tx.hash);

  // Verify
  const info = await vaultContract.getVaultInfo();
  console.log('\n=== Fee Vault Live ===');
  console.log('Accumulated ETH:', ethers.formatEther(info.accETH));
  console.log('Accumulated Tokens:', ethers.formatEther(info.accTokens));
  console.log('Fee Rate:', info.feeRate.toString(), 'bps');
  console.log('LP Fees Cut:', info.lpFeesCut.toString(), 'bps');
  console.log('Fee Recipient:', info.currentFeeRecipient);
  console.log('Pending Recipient:', info.pendingRecipient);

  // Update deployment info
  const deployInfo = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '..', 'artifacts', 'diamond', 'deployment.json'), 'utf8'
  ));
  deployInfo.feeVaultFacet = facetAddr;
  deployInfo.feeVaultSelectors = sels;
  deployInfo.feeVault = {
    feeRate: '250 bps (2.5%)',
    lpFeesCut: '8000 bps (80%)',
    timelockDuration: '60 seconds',
    initialDeposit: '10000 SPOOF'
  };
  fs.writeFileSync(
    path.resolve(__dirname, '..', 'artifacts', 'diamond', 'deployment.json'),
    JSON.stringify(deployInfo, null, 2)
  );
  console.log('\nDone. Fee vault is live with 10K SPOOF claimable by fee recipient.');
}

main().catch(err => { console.error(err); process.exit(1); });
