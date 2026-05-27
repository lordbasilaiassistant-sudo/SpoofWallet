/**
 * live-scan.js — Red Team fee-recipient vulnerability scanner
 *
 * Scans contracts on Base mainnet for unprotected fee-recipient
 * change functions. RESPONSIBLE DISCLOSURE only.
 *
 * Strategy (adapted for free Basescan API tier):
 *   1. Harvest token addresses from Clanker factory creation events
 *   2. Find launchpad / DEX / fee-bearing contracts from known addresses + internal tx traces
 *   3. Fetch source code and analyze for fee-recipient vulns
 *   4. Check access control on any fee-related setters
 *
 * Usage: node scripts/live-scan.js
 */

const { ethers } = require('ethers');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ─── Config ─────────────────────────────────────────────────────────
const BASESCAN_API_KEY = 'REAGIMEAPZ25INJZTVGEWXC48JEZZEQGFQ';
const BASE_RPC = 'https://mainnet.base.org';
const API_BASE = 'https://api.etherscan.io/v2/api?chainid=8453';
const RATE_LIMIT_MS = 220; // Free tier ~5/sec

// ─── Known Contracts to Check ───────────────────────────────────────
// These are known launchpads, DEXes, and fee-bearing contracts on Base.
// We add more dynamically by scanning factory outputs.
const SEED_CONTRACTS = [
  // Clanker ecosystem
  { address: '0xe85a59c628f7d27878aceb4bf3b35733630083a9', label: 'Clanker V4 Factory' },
  // Uniswap V3 / Base DEX infrastructure
  { address: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD', label: 'Uniswap V3 Factory (Base)' },
  { address: '0x2626664c2603336E57B271c5C0b26F421741e481', label: 'Uniswap Universal Router (Base)' },
  // Aerodrome (major Base DEX)
  { address: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da', label: 'Aerodrome Router' },
  { address: '0x5D5Bea9f0Fc13d967511668a60a3369fD53F784F', label: 'Aerodrome Voter' },
  // Friend.tech / SocialFi
  { address: '0xCF205808Ed36593aa40a44F10c7f7C2F67d4A4d4', label: 'friend.tech FriendtechSharesV1' },
  // Base DEX aggregators / launchpads
  { address: '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD', label: 'Uniswap UniversalRouter V1' },
  // Additional fee-bearing patterns found in the wild
  { address: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24', label: 'Quoter V2 (Base)' },
];

// Known token factories — we'll pull their recent deployments
const TOKEN_FACTORIES = [
  {
    address: '0xe85a59c628f7d27878aceb4bf3b35733630083a9',
    label: 'Clanker V4',
    // TokenCreated event signature
    eventTopic: null, // Will discover from ABI
  },
];

// ─── Fee function patterns ──────────────────────────────────────────
const FEE_SETTER_REGEX = /function\s+(set|change|update|assign|configure)(?:Fee|Tax|Treasury|Revenue|Protocol|Dev|Marketing|Team|Reward|LP|Liquidity|Burn|Charity|Auto|Swap|Buy|Sell)(?:Recipient|Address|Collector|Wallet|Receiver|Destination|Rate|Percent|Percentage|BPS|Basis)?\s*\(/gi;

const FEE_ACCUMULATION_REGEX = /(?:_fee|_tax|_accumulated|_collected|_pending|taxAmount|feeAmount|totalFees|collectedFees)\s*(?:\+\=|\=\s*\w+\s*\+)/gi;

const WITHDRAW_REGEX = /function\s+(?:withdraw|claim|collect|sweep|drain|rescue|recover|transfer)(?:Fees?|Tax(?:es)?|Revenue|Tokens?|ETH|Funds?)?\s*\(/gi;

// Access control patterns
const HAS_ACCESS_CONTROL = [
  /onlyOwner/,
  /onlyAdmin/,
  /onlyRole\s*\(/,
  /onlyGovernance/,
  /onlyOperator/,
  /onlyMultisig/,
  /onlyManager/,
  /onlyAuthorized/,
  /require\s*\(\s*msg\.sender\s*==\s*(?:owner|_owner|admin|_admin|governance|operator|manager)/,
  /require\s*\(\s*_msgSender\(\)\s*==\s*(?:owner|_owner|admin)/,
  /require\s*\(\s*hasRole\s*\(/,
  /require\s*\(\s*isOwner\[/,
  /if\s*\(\s*msg\.sender\s*!=\s*(?:owner|_owner|admin)/,
  /AccessControl/,
  /Ownable/,
];

// ─── Helpers ────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 20000 }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse: ${e.message}\n${data.slice(0,300)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function apiCall(module, action, params = {}) {
  const qs = Object.entries(params).map(([k,v]) => `&${k}=${encodeURIComponent(v)}`).join('');
  const url = `${API_BASE}&module=${module}&action=${action}${qs}&apikey=${BASESCAN_API_KEY}`;
  await sleep(RATE_LIMIT_MS);
  return httpsGet(url);
}

async function getContractSource(address) {
  const resp = await apiCall('contract', 'getsourcecode', { address });
  if (resp.status === '1' && resp.result && resp.result.length > 0) {
    return resp.result[0];
  }
  return null;
}

async function getContractABI(address) {
  const resp = await apiCall('contract', 'getabi', { address });
  if (resp.status === '1' && resp.result) {
    try { return JSON.parse(resp.result); }
    catch { return null; }
  }
  return null;
}

async function getInternalTxsByAddress(address, startBlock = 0, endBlock = 99999999) {
  const resp = await apiCall('account', 'txlistinternal', {
    address,
    startblock: startBlock,
    endblock: endBlock,
    page: 1,
    offset: 50,
    sort: 'desc',
  });
  if (resp.status === '1' && resp.result) return resp.result;
  return [];
}

async function getNormalTxsByAddress(address, startBlock = 0, endBlock = 99999999) {
  const resp = await apiCall('account', 'txlist', {
    address,
    startblock: startBlock,
    endblock: endBlock,
    page: 1,
    offset: 100,
    sort: 'desc',
  });
  if (resp.status === '1' && resp.result) return resp.result;
  return [];
}

async function getTokenTxsByAddress(address) {
  const resp = await apiCall('account', 'tokentx', {
    address,
    page: 1,
    offset: 100,
    sort: 'desc',
  });
  if (resp.status === '1' && resp.result) return resp.result;
  return [];
}

async function getLogs(address, fromBlock, toBlock, topic0) {
  const params = { address, fromBlock, toBlock };
  if (topic0) params.topic0 = topic0;
  const resp = await apiCall('logs', 'getLogs', params);
  if (resp.status === '1' && resp.result) return resp.result;
  return [];
}

function parseSource(sourceData) {
  if (!sourceData || !sourceData.SourceCode) return '';
  let src = sourceData.SourceCode;
  if (src.startsWith('{{') || src.startsWith('{')) {
    try {
      const raw = src.startsWith('{{') ? src.slice(1, -1) : src;
      const parsed = JSON.parse(raw);
      if (parsed.sources) {
        return Object.values(parsed.sources).map(s => s.content || '').join('\n');
      }
      return src;
    } catch { return src; }
  }
  return src;
}

// ─── Analysis Functions ─────────────────────────────────────────────

function extractFunctionBlock(source, matchIndex) {
  // Get ~200 chars before the match for modifier context
  const preContext = Math.max(0, matchIndex - 200);
  // Find opening brace
  let braceStart = source.indexOf('{', matchIndex);
  if (braceStart === -1 || braceStart > matchIndex + 500) {
    return source.slice(preContext, matchIndex + 500);
  }
  // Match braces
  let depth = 0, i = braceStart;
  for (; i < source.length && i < braceStart + 5000; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') { depth--; if (depth === 0) break; }
  }
  return source.slice(preContext, i + 1);
}

function hasAccessControl(funcBlock) {
  for (const pat of HAS_ACCESS_CONTROL) {
    if (pat.test(funcBlock)) return true;
  }
  return false;
}

function analyzeContract(sourceCode, contractName, address) {
  const findings = [];
  if (!sourceCode || sourceCode.length < 50) return findings;

  // --- Pass 1: Find fee-related setter functions ---
  FEE_SETTER_REGEX.lastIndex = 0;
  let match;
  const seenFuncs = new Set();

  while ((match = FEE_SETTER_REGEX.exec(sourceCode)) !== null) {
    const funcBlock = extractFunctionBlock(sourceCode, match.index);
    // Extract function name
    const nameMatch = funcBlock.match(/function\s+(\w+)\s*\(/);
    const funcName = nameMatch ? nameMatch[1] : match[0];

    if (seenFuncs.has(funcName)) continue;
    seenFuncs.add(funcName);

    // Check visibility — only external/public are callable
    const isPublicOrExternal = /(?:external|public)/.test(funcBlock.slice(0, 400));
    // Some functions don't explicitly state visibility (Solidity <0.5 defaults to public)
    const hasVisibility = /(?:external|public|internal|private)/.test(funcBlock.slice(0, 400));

    if (!isPublicOrExternal && hasVisibility) continue; // internal/private = safe

    const protected = hasAccessControl(funcBlock);

    if (!protected) {
      // Extract the relevant snippet — just the function header + body
      const funcHeaderMatch = funcBlock.match(/function\s+\w+[^{]*/);
      const header = funcHeaderMatch ? funcHeaderMatch[0].trim() : '';

      findings.push({
        severity: 'CRITICAL',
        type: 'UNPROTECTED_FEE_SETTER',
        function: funcName,
        header: header.slice(0, 300),
        snippet: funcBlock.slice(Math.max(0, funcBlock.indexOf('function')), Math.min(funcBlock.length, funcBlock.indexOf('function') + 800)),
        detail: `Function ${funcName} changes fee/tax recipient or rate with NO access control modifier or require check on msg.sender.`,
      });
    }
  }

  // --- Pass 2: Unprotected withdraw/claim functions ---
  WITHDRAW_REGEX.lastIndex = 0;
  while ((match = WITHDRAW_REGEX.exec(sourceCode)) !== null) {
    const funcBlock = extractFunctionBlock(sourceCode, match.index);
    const nameMatch = funcBlock.match(/function\s+(\w+)\s*\(/);
    const funcName = nameMatch ? nameMatch[1] : 'withdraw';

    if (seenFuncs.has(funcName)) continue;
    seenFuncs.add(funcName);

    const isPublicOrExternal = /(?:external|public)/.test(funcBlock.slice(0, 400));
    const hasVisibility = /(?:external|public|internal|private)/.test(funcBlock.slice(0, 400));
    if (!isPublicOrExternal && hasVisibility) continue;

    const protected = hasAccessControl(funcBlock);

    // Check if it sends ETH or tokens to msg.sender (drain pattern)
    const sendToSender = /(?:msg\.sender|_msgSender\(\))\.(?:transfer|call|send)|payable\s*\(\s*(?:msg\.sender|_msgSender\(\))\s*\)/.test(funcBlock);
    const sendsValue = /\.(?:transfer|call|send)\s*[\({]/.test(funcBlock);

    if (!protected && (sendToSender || sendsValue)) {
      findings.push({
        severity: 'CRITICAL',
        type: 'UNPROTECTED_FUND_WITHDRAWAL',
        function: funcName,
        snippet: funcBlock.slice(Math.max(0, funcBlock.indexOf('function')), Math.min(funcBlock.length, funcBlock.indexOf('function') + 800)),
        detail: `Function ${funcName} can withdraw funds without access control. Sends value to caller or specified address.`,
      });
    }
  }

  // --- Pass 3: Fee-on-transfer tokens with changeable fee recipient ---
  // Look for transfer overrides that take fees
  const hasFeeOnTransfer = /function\s+_transfer[^{]*\{[^}]*(?:fee|tax|_taxAmount|_feeAmount)/is.test(sourceCode);
  if (hasFeeOnTransfer) {
    // Check if fee recipient is changeable without access control
    const recipientVars = sourceCode.match(/(?:feeRecipient|taxRecipient|_feeWallet|_taxWallet|_marketingWallet|_devWallet|_teamWallet|treasuryAddress)\s*=/g);
    if (recipientVars && recipientVars.length > 0) {
      // We already checked setter functions above, but flag the contract as fee-bearing
      if (findings.length === 0) {
        // No unprotected setters found, but mark as fee-bearing for manual review
        findings.push({
          severity: 'INFO',
          type: 'FEE_ON_TRANSFER_TOKEN',
          function: '_transfer',
          detail: `Token has fee-on-transfer with changeable recipient variables: ${[...new Set(recipientVars)].join(', ')}. Setter access control appears present but warrants manual review.`,
        });
      }
    }
  }

  // --- Pass 4: Deployer-gated functions where deployer might be a factory ---
  const deployerGatedFuncs = sourceCode.match(/require\s*\(\s*msg\.sender\s*==\s*(?:deployer|_deployer|creator|_creator|factory|_factory)\s*[,)]/g);
  if (deployerGatedFuncs) {
    // Check if deployer is set in constructor from msg.sender
    const deployerSetInConstructor = /constructor[^{]*\{[^}]*(?:deployer|_deployer|creator|_creator)\s*=\s*msg\.sender/is.test(sourceCode);
    if (deployerSetInConstructor) {
      findings.push({
        severity: 'MEDIUM',
        type: 'DEPLOYER_GATED_CHECK_IF_FACTORY',
        function: 'multiple',
        detail: `Contract uses deployer/creator as access control (set from msg.sender in constructor). If deployed by a factory, the factory contract is the "deployer" — check if the factory allows arbitrary calls that would satisfy this check.`,
      });
    }
  }

  return findings;
}

// ─── Contract Discovery ─────────────────────────────────────────────

async function discoverContractsFromFactory(provider, factoryAddress, label) {
  console.log(`  [*] Discovering tokens from ${label} (${factoryAddress})...`);

  // Get recent transactions TO the factory (token creation txns)
  const txs = await getNormalTxsByAddress(factoryAddress);
  const contractAddresses = new Set();

  if (txs.length > 0) {
    console.log(`    Found ${txs.length} recent transactions`);
    // Look at internal txs which would be the factory creating tokens
    await sleep(RATE_LIMIT_MS);
    const internalTxs = await getInternalTxsByAddress(factoryAddress);
    for (const itx of internalTxs) {
      if (itx.type === 'create' || itx.type === 'create2') {
        contractAddresses.add(itx.contractAddress);
      }
    }
    console.log(`    Found ${contractAddresses.size} contracts created by factory`);
  }

  return [...contractAddresses];
}

async function discoverFeeContracts(provider) {
  console.log('\n[*] Discovering fee-bearing contracts via heuristics...\n');
  const discovered = [];

  // Method 1: Get recent token transfers to find active fee-bearing tokens
  // We check the THRYX treasury's recent token interactions to find contracts we've interacted with
  const THRYX_TREASURY = '0x7a3E312Ec6e20a9F62fE2405938EB9060312E334';

  console.log('  [*] Checking tokens interacted with by THRYX treasury...');
  const tokenTxs = await getTokenTxsByAddress(THRYX_TREASURY);

  if (tokenTxs.length > 0) {
    const uniqueContracts = new Set();
    for (const tx of tokenTxs) {
      if (tx.contractAddress) uniqueContracts.add(tx.contractAddress.toLowerCase());
    }
    console.log(`    Found ${uniqueContracts.size} unique token contracts`);
    for (const addr of uniqueContracts) {
      discovered.push({ address: addr, label: 'Token (THRYX interaction)' });
    }
  }

  // Method 2: Factory-created contracts
  for (const factory of TOKEN_FACTORIES) {
    const addrs = await discoverContractsFromFactory(provider, factory.address, factory.label);
    for (const addr of addrs) {
      discovered.push({ address: addr, label: `Token (${factory.label})` });
    }
  }

  return discovered;
}

// ─── Fee Value Estimation ───────────────────────────────────────────

async function estimateFeeValue(provider, address) {
  try {
    const balance = await provider.getBalance(address);
    const ethBalance = parseFloat(ethers.formatEther(balance));
    return { ethBalance, hasETH: ethBalance > 0.001 };
  } catch {
    return { ethBalance: 0, hasETH: false };
  }
}

// ─── Main ───────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(70));
  console.log('  THRYX Red Team — Fee-Recipient Vulnerability Scanner');
  console.log('  Target: Base Mainnet (chainId 8453)');
  console.log('  Mode: RESPONSIBLE DISCLOSURE');
  console.log('  Date: ' + new Date().toISOString());
  console.log('='.repeat(70));
  console.log();

  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  const allFindings = [];
  let totalScanned = 0;
  let totalWithSource = 0;

  // Phase 1: Scan seed contracts (known important contracts)
  console.log('[Phase 1] Scanning known seed contracts...\n');

  for (const { address, label } of SEED_CONTRACTS) {
    totalScanned++;
    process.stdout.write(`  [${totalScanned}] ${label} (${address.slice(0,10)}...) `);

    const sourceData = await getContractSource(address);
    if (!sourceData || !sourceData.SourceCode || sourceData.SourceCode === '') {
      console.log('- NO SOURCE');
      continue;
    }

    totalWithSource++;
    const sourceCode = parseSource(sourceData);
    const contractName = sourceData.ContractName || label;
    const findings = analyzeContract(sourceCode, contractName, address);

    if (findings.length > 0) {
      const crits = findings.filter(f => f.severity === 'CRITICAL');
      const highs = findings.filter(f => f.severity === 'HIGH');
      console.log(`- ${crits.length} CRITICAL, ${highs.length} HIGH, ${findings.length} total`);

      // Estimate value at risk
      const value = await estimateFeeValue(provider, address);

      allFindings.push({
        address,
        label,
        contractName,
        compiler: sourceData.CompilerVersion,
        ethBalance: value.ethBalance,
        findings,
      });
    } else {
      console.log('- clean');
    }
  }

  // Phase 2: Discover and scan fee-bearing token contracts
  console.log('\n[Phase 2] Discovering fee-bearing contracts...\n');

  const discovered = await discoverFeeContracts(provider);
  // Deduplicate against seed contracts
  const seedAddrs = new Set(SEED_CONTRACTS.map(s => s.address.toLowerCase()));
  const uniqueDiscovered = discovered.filter(d => !seedAddrs.has(d.address.toLowerCase()));

  // Limit to first 50 to stay within rate limits
  const toScan = uniqueDiscovered.slice(0, 50);
  console.log(`\n  [*] Scanning ${toScan.length} discovered contracts...\n`);

  for (const { address, label } of toScan) {
    totalScanned++;
    process.stdout.write(`  [${totalScanned}] ${label} (${address.slice(0,10)}...) `);

    try {
      const sourceData = await getContractSource(address);
      if (!sourceData || !sourceData.SourceCode || sourceData.SourceCode === '') {
        console.log('- no source');
        continue;
      }

      totalWithSource++;
      const sourceCode = parseSource(sourceData);
      const contractName = sourceData.ContractName || label;
      const findings = analyzeContract(sourceCode, contractName, address);

      if (findings.length > 0) {
        const crits = findings.filter(f => f.severity === 'CRITICAL');
        console.log(`- ${crits.length} CRIT, ${findings.length} total findings`);

        const value = await estimateFeeValue(provider, address);

        allFindings.push({
          address,
          label,
          contractName,
          compiler: sourceData.CompilerVersion,
          ethBalance: value.ethBalance,
          findings,
        });
      } else {
        console.log('- clean');
      }
    } catch (err) {
      console.log(`- ERROR: ${err.message.slice(0, 60)}`);
    }
  }

  // Phase 3: Deep-dive on Clanker locker pattern
  console.log('\n[Phase 3] Checking Clanker LP locker fee-claim patterns...\n');

  // The Clanker factory creates tokens + LP positions. LP fees flow to a locker.
  // Check the factory source for how lockers are set up.
  const clankerSource = await getContractSource('0xe85a59c628f7d27878aceb4bf3b35733630083a9');
  if (clankerSource && clankerSource.SourceCode) {
    const src = parseSource(clankerSource);

    // Look for locker-related patterns
    const lockerRefs = src.match(/locker|Locker|LOCKER|lockContract|LockContract/g);
    const feeClaimRefs = src.match(/claimFee|collectFee|claimLP|lpFee|protocolFee/gi);

    console.log(`  Clanker source size: ${src.length} chars`);
    console.log(`  Locker references: ${lockerRefs ? lockerRefs.length : 0}`);
    console.log(`  Fee-claim references: ${feeClaimRefs ? feeClaimRefs.length : 0}`);

    // Search for fee recipient assignment in Clanker
    const feeRecipientAssignments = [];
    const regex = /(?:feeRecipient|lpFeeRecipient|protocolFee|creator|tokenCreator)\s*[=:]/gi;
    let m;
    while ((m = regex.exec(src)) !== null) {
      const context = src.slice(Math.max(0, m.index - 100), m.index + 200);
      feeRecipientAssignments.push(context.trim());
    }

    if (feeRecipientAssignments.length > 0) {
      console.log(`  Fee recipient assignments found: ${feeRecipientAssignments.length}`);
      for (const ctx of feeRecipientAssignments.slice(0, 5)) {
        console.log(`    ...${ctx.slice(0, 150)}`);
      }
    }

    // Analyze the factory itself for fee vulns
    const factoryFindings = analyzeContract(src, 'Clanker V4 Factory', '0xe85a59c628f7d27878aceb4bf3b35733630083a9');
    if (factoryFindings.length > 0) {
      console.log(`\n  [!!!] Clanker factory findings: ${factoryFindings.length}`);
      allFindings.push({
        address: '0xe85a59c628f7d27878aceb4bf3b35733630083a9',
        label: 'Clanker V4 Factory',
        contractName: 'Clanker',
        findings: factoryFindings,
        note: 'FACTORY — findings here impact ALL tokens deployed through Clanker V4',
      });
    }
  }

  // ─── Report ─────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(70));
  console.log('  SCAN RESULTS');
  console.log('='.repeat(70));
  console.log(`  Total contracts scanned:     ${totalScanned}`);
  console.log(`  With verified source code:   ${totalWithSource}`);
  console.log(`  Contracts with findings:     ${allFindings.length}`);

  const critCount = allFindings.reduce((n, f) => n + f.findings.filter(x => x.severity === 'CRITICAL').length, 0);
  const highCount = allFindings.reduce((n, f) => n + f.findings.filter(x => x.severity === 'HIGH').length, 0);
  const medCount = allFindings.reduce((n, f) => n + f.findings.filter(x => x.severity === 'MEDIUM').length, 0);
  const infoCount = allFindings.reduce((n, f) => n + f.findings.filter(x => x.severity === 'INFO').length, 0);

  console.log(`  CRITICAL findings:           ${critCount}`);
  console.log(`  HIGH findings:               ${highCount}`);
  console.log(`  MEDIUM findings:             ${medCount}`);
  console.log(`  INFO findings:               ${infoCount}`);

  // Save JSON results
  const outputDir = path.join(__dirname, '..', 'research');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const jsonPath = path.join(outputDir, 'live-scan-results.json');
  fs.writeFileSync(jsonPath, JSON.stringify({
    scanDate: new Date().toISOString(),
    chain: 'Base (8453)',
    totalScanned,
    totalWithSource,
    criticalCount: critCount,
    highCount,
    mediumCount: medCount,
    findings: allFindings,
  }, null, 2));
  console.log(`\n  JSON results: ${jsonPath}`);

  // Print detailed findings
  if (allFindings.length > 0) {
    console.log('\n' + '='.repeat(70));
    console.log('  DETAILED FINDINGS');
    console.log('='.repeat(70));

    for (const contract of allFindings) {
      console.log(`\n  Contract: ${contract.contractName || contract.label}`);
      console.log(`  Address:  ${contract.address}`);
      if (contract.ethBalance !== undefined) {
        console.log(`  ETH Balance: ${contract.ethBalance.toFixed(6)} ETH`);
      }
      if (contract.note) console.log(`  Note: ${contract.note}`);
      console.log('  ---');

      for (const f of contract.findings) {
        console.log(`  [${f.severity}] ${f.type}: ${f.function}`);
        console.log(`    ${f.detail}`);
        if (f.header) console.log(`    Header: ${f.header.slice(0, 200)}`);
        if (f.snippet) {
          console.log('    Snippet:');
          const lines = f.snippet.split('\n').slice(0, 15);
          for (const line of lines) {
            console.log(`      ${line}`);
          }
          if (f.snippet.split('\n').length > 15) console.log('      ...(truncated)');
        }
        console.log();
      }
    }
  }

  // Print actionable summary
  if (critCount > 0) {
    console.log('\n' + '!'.repeat(70));
    console.log('  ACTION REQUIRED: CRITICAL findings detected');
    console.log('  Per THRYX Red Team protocol: notify Ren + Eli TODAY');
    console.log('  These contracts may have exploitable fee-recipient vulnerabilities');
    console.log('  DO NOT EXPLOIT — prepare responsible disclosure');
    console.log('!'.repeat(70));
  }

  return allFindings;
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
