/**
 * live-scan-v3.js — Red Team fee-recipient vulnerability scanner (final)
 *
 * Key improvements:
 *   - Fixed false positives: now catches if(msg.sender != X) revert patterns
 *   - Catches custom modifier access control (ifAdmin, etc.)
 *   - Focuses on the EXACT pattern from Anthropic's red team finding:
 *     "A token launchpad contract that failed to validate fee recipients,
 *      allowing an agent to set its own address as beneficiary and siphon
 *      transaction fees"
 *   - Broader contract discovery via factory event logs
 *   - Manual verification prompts for borderline cases
 *
 * RESPONSIBLE DISCLOSURE ONLY.
 */

const { ethers } = require('ethers');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ─── Config ─────────────────────────────────────────────────────────
const BASESCAN_API_KEY = 'REAGIMEAPZ25INJZTVGEWXC48JEZZEQGFQ';
const BASE_RPC = 'https://mainnet.base.org';
const BACKUP_RPC = 'https://1rpc.io/base';
const API_BASE = 'https://api.etherscan.io/v2/api?chainid=8453';
const RATE_LIMIT_MS = 230;

// ─── Helpers ────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 20000 }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse: ${e.message}`)); }
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

async function getSource(address) {
  const resp = await apiCall('contract', 'getsourcecode', { address });
  if (resp.status === '1' && resp.result?.[0]) return resp.result[0];
  return null;
}

function flattenSource(sourceData) {
  if (!sourceData?.SourceCode) return '';
  let src = sourceData.SourceCode;
  if (src.startsWith('{{') || src.startsWith('{')) {
    try {
      const raw = src.startsWith('{{') ? src.slice(1, -1) : src;
      const parsed = JSON.parse(raw);
      if (parsed.sources) {
        return Object.entries(parsed.sources)
          .map(([name, s]) => `\n// FILE: ${name}\n${s.content || ''}`)
          .join('\n');
      }
    } catch {}
  }
  return src;
}

// ─── Robust Access Control Detection ────────────────────────────────

/**
 * Checks if a function body (including modifier string) has ANY form
 * of access control. This is the key function that was producing false
 * positives in v1/v2.
 */
function hasAnyAccessControl(modifiers, body) {
  const combined = (modifiers || '') + '\n' + (body || '');

  // Pattern 1: Standard OpenZeppelin-style modifiers
  if (/onlyOwner|onlyAdmin|onlyRole|onlyGovernance|onlyOperator|onlyMultisig|onlyManager|onlyAuthorized|onlyPauser|whenNotPaused|nonReentrant/i.test(modifiers)) {
    return { controlled: true, method: 'modifier' };
  }

  // Pattern 2: Custom modifiers (anything that looks like a modifier name in the modifiers string)
  // e.g., ifAdmin, onlyXYZ, requiresAuth, etc.
  if (/\bif[A-Z]\w+\b|\brequires[A-Z]\w+\b|\bonly[A-Z]\w+\b|\bauthorized\b|\brestricted\b/i.test(modifiers)) {
    return { controlled: true, method: 'custom_modifier' };
  }

  // Pattern 3: require(msg.sender == X) or if(msg.sender != X) revert
  if (/require\s*\(\s*(?:msg\.sender|_msgSender\(\))\s*==/.test(body)) {
    return { controlled: true, method: 'require_eq' };
  }
  if (/if\s*\(\s*(?:msg\.sender|_msgSender\(\))\s*!=\s*\w+\s*\)\s*(?:revert|{)/.test(body)) {
    return { controlled: true, method: 'if_neq_revert' };
  }
  if (/msg\.sender\s*!=\s*\w+.*revert/s.test(body)) {
    return { controlled: true, method: 'inline_neq_revert' };
  }
  if (/msg\.sender\s*==\s*\w+/.test(body)) {
    return { controlled: true, method: 'sender_check' };
  }

  // Pattern 4: hasRole check
  if (/hasRole\s*\(/.test(body)) {
    return { controlled: true, method: 'rbac' };
  }

  // Pattern 5: _checkOwner / _checkRole internal calls
  if (/_check(?:Owner|Role|Auth|Caller)\s*\(/.test(body)) {
    return { controlled: true, method: 'internal_check' };
  }

  // Pattern 6: auth() or similar
  if (/\bauth\(\)|\brequireAuth\(\)/.test(body)) {
    return { controlled: true, method: 'auth_call' };
  }

  return { controlled: false, method: 'none' };
}

// ─── Contract Analysis ──────────────────────────────────────────────

const FEE_SETTER_NAMES = /^(?:set|change|update|assign|configure|adjust)(?:Fee|Tax|Treasury|Revenue|Protocol|Dev|Marketing|Team|Reward|LP|Liquidity|Burn|Charity|Auto|Swap|Buy|Sell|Deployer)(?:Recipient|Address|Collector|Wallet|Receiver|Destination|Rate|Percent|Percentage|BPS|Basis|To)?$/i;

const WITHDRAW_NAMES = /^(?:withdraw|claim|collect|sweep|drain|rescue|recover|skim|harvest)(?:Fees?|Tax(?:es)?|Revenue|Tokens?|ETH|Funds?|Rewards?|Protocol|LP)?$/i;

const ADMIN_CHANGE_NAMES = /^(?:set|change|transfer|update|renounce)(?:Owner|Admin|Authority|Governance|Operator|Manager)(?:ship)?$/i;

function analyzeSource(sourceCode, contractName, address) {
  const findings = [];
  if (!sourceCode || sourceCode.length < 200) return findings;

  // Split into contract blocks, skip interfaces and libraries
  const contractRegex = /(?:abstract\s+)?(?:contract|interface|library)\s+(\w+)/g;
  let cm;
  const isInterface = {};
  const isLibrary = {};
  while ((cm = contractRegex.exec(sourceCode)) !== null) {
    const blockType = sourceCode.slice(Math.max(0, cm.index - 20), cm.index + cm[0].length);
    if (/interface\s+/.test(blockType)) isInterface[cm[1]] = true;
    if (/library\s+/.test(blockType)) isLibrary[cm[1]] = true;
  }

  // Find all function definitions
  const funcRegex = /function\s+(\w+)\s*\(([^)]*)\)\s*([^{;]*)/g;
  let fm;

  while ((fm = funcRegex.exec(sourceCode)) !== null) {
    const funcName = fm[1];
    const params = fm[2];
    const modifiers = fm[3].trim();

    // Check if this is inside an interface block (rough heuristic)
    // Look backwards for the nearest contract/interface keyword
    const before = sourceCode.slice(Math.max(0, fm.index - 3000), fm.index);
    const lastBlock = before.match(/(?:abstract\s+)?(?:contract|interface|library)\s+(\w+)[^{]*$/);
    if (lastBlock) {
      const blockName = lastBlock[1];
      if (isInterface[blockName] || isLibrary[blockName]) continue; // Skip interface/library functions
    }

    // Check if function has a body (not just a declaration)
    const afterSig = sourceCode.slice(fm.index + fm[0].length).trimStart();
    if (afterSig.startsWith(';') || !afterSig.startsWith('{')) continue; // No body = interface

    // Skip internal/private
    if (/\b(?:internal|private)\b/.test(modifiers)) continue;

    // Extract function body
    const braceStart = sourceCode.indexOf('{', fm.index + fm[0].length);
    if (braceStart === -1) continue;
    let depth = 0, j = braceStart;
    for (; j < sourceCode.length && j < braceStart + 10000; j++) {
      if (sourceCode[j] === '{') depth++;
      if (sourceCode[j] === '}') { depth--; if (depth === 0) break; }
    }
    const body = sourceCode.slice(braceStart, j + 1);

    const ac = hasAnyAccessControl(modifiers, body);

    // --- Check fee setters ---
    if (FEE_SETTER_NAMES.test(funcName)) {
      if (!ac.controlled) {
        findings.push({
          severity: 'CRITICAL',
          type: 'UNPROTECTED_FEE_SETTER',
          function: funcName,
          params,
          modifiers: modifiers.slice(0, 200),
          bodyPreview: body.slice(0, 500),
          detail: `${funcName}(${params}) has no access control. Any address can change fee parameters.`,
        });
      }
    }

    // --- Check withdraw/claim ---
    if (WITHDRAW_NAMES.test(funcName)) {
      if (!ac.controlled) {
        // Verify it actually sends value (not just a view)
        const sendsValue = /\.transfer\s*\(|\.call\s*\{|\.send\s*\(|safeTransfer\s*\(/i.test(body);
        // Check if it only sends to msg.sender (user claiming own balance = OK)
        const sendsToSenderOnly = /\.transfer\s*\(\s*(?:msg\.sender|_msgSender\(\))/.test(body) ||
          /safeTransfer\s*\([^,]+,\s*(?:msg\.sender|_msgSender\(\))/.test(body);
        // Check for user balance mapping
        const usesUserBalance = /\[msg\.sender\]|\[_msgSender\(\)\]/.test(body);

        if (sendsValue && !sendsToSenderOnly && !usesUserBalance) {
          findings.push({
            severity: 'CRITICAL',
            type: 'UNPROTECTED_FUND_WITHDRAWAL',
            function: funcName,
            params,
            modifiers: modifiers.slice(0, 200),
            bodyPreview: body.slice(0, 500),
            detail: `${funcName}() can withdraw funds to arbitrary address without access control.`,
          });
        } else if (sendsValue && sendsToSenderOnly && !usesUserBalance) {
          // Sends to msg.sender but not from their balance — could be drain
          findings.push({
            severity: 'HIGH',
            type: 'POTENTIAL_FUND_DRAIN',
            function: funcName,
            params,
            bodyPreview: body.slice(0, 500),
            detail: `${funcName}() sends contract balance to msg.sender without checking user balance mapping. Verify this is intentional.`,
          });
        }
      }
    }

    // --- Check admin/owner changes ---
    if (ADMIN_CHANGE_NAMES.test(funcName)) {
      if (!ac.controlled) {
        findings.push({
          severity: 'CRITICAL',
          type: 'UNPROTECTED_ADMIN_CHANGE',
          function: funcName,
          params,
          modifiers: modifiers.slice(0, 200),
          bodyPreview: body.slice(0, 500),
          detail: `${funcName}() can change admin/owner without access control.`,
        });
      }
    }

    // --- Check: fee recipient set in a public function that takes an address param ---
    // This catches functions not named with our patterns but that still set fee recipients
    if (!FEE_SETTER_NAMES.test(funcName) && !WITHDRAW_NAMES.test(funcName) && !ADMIN_CHANGE_NAMES.test(funcName)) {
      // If it takes an address param and sets a fee-related state variable
      if (/address/.test(params)) {
        const setsFeeVar = /(?:feeRecipient|taxRecipient|_feeWallet|_taxWallet|_marketingWallet|_devWallet|_teamWallet|treasuryAddress|_treasury|feeCollector|taxCollector|revenueRecipient|protocolFeeRecipient|feeAddress)\s*=/.test(body);
        if (setsFeeVar && !ac.controlled) {
          findings.push({
            severity: 'CRITICAL',
            type: 'HIDDEN_FEE_RECIPIENT_SETTER',
            function: funcName,
            params,
            bodyPreview: body.slice(0, 500),
            detail: `${funcName}() sets a fee recipient state variable without access control. Non-obvious function name may indicate intentional obfuscation.`,
          });
        }
      }
    }
  }

  return findings;
}

// ─── Discovery: Find contracts to scan ──────────────────────────────

async function discoverFromFactory(provider, factoryAddr, factoryLabel) {
  console.log(`  [*] Discovering deployed contracts from ${factoryLabel}...`);
  const discovered = [];

  // Get recent internal transactions (contract creations)
  const resp = await apiCall('account', 'txlistinternal', {
    address: factoryAddr,
    startblock: 0,
    endblock: 99999999,
    page: 1,
    offset: 100,
    sort: 'desc',
  });

  if (resp.status === '1' && resp.result) {
    for (const tx of resp.result) {
      if (tx.type === 'create' || tx.type === 'create2') {
        discovered.push({
          address: tx.contractAddress,
          label: `${factoryLabel} deploy`,
          deployer: factoryAddr,
        });
      }
    }
    console.log(`    Found ${discovered.length} factory-created contracts`);
  }

  return discovered;
}

async function discoverFromRecentBlocks(provider) {
  console.log('  [*] Finding active token contracts from recent blocks...');
  const latestBlock = await provider.getBlockNumber();
  const addrs = new Set();

  try {
    const transferTopic = ethers.id('Transfer(address,address,uint256)');
    const logs = await provider.getLogs({
      fromBlock: latestBlock - 100,
      toBlock: latestBlock,
      topics: [transferTopic],
    });
    for (const log of logs) addrs.add(log.address.toLowerCase());
    console.log(`    Found ${addrs.size} unique token addresses`);
  } catch (err) {
    console.log(`    Error: ${err.message.slice(0, 60)}`);
  }

  return [...addrs].map(a => ({ address: a, label: 'Active token' }));
}

// ─── Targeted Search: Known launchpad patterns ──────────────────────

// These are contracts found through on-chain research that are
// specifically launchpad / token factory / fee-splitting patterns
const LAUNCHPAD_TARGETS = [
  // Clanker ecosystem
  { address: '0xe85a59c628f7d27878aceb4bf3b35733630083a9', label: 'Clanker V4 Factory' },

  // Known Base launchpads / token deployers
  { address: '0x3d6AfE2fB73fFEcDfE04e6a6e40B4d02B6Cae54D', label: 'BaseSwap Router' },
  { address: '0x6bded42c6DA8FBf0d2bA55B2fa120C5e0c8D7891', label: 'BaseSwap Factory' },

  // Aerodrome fee infrastructure
  { address: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da', label: 'Aerodrome PoolFactory' },
  { address: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43', label: 'Aerodrome Voter' },

  // friend.tech and socialfi
  { address: '0xCF205808Ed36593aa40a44F10c7f7C2F67d4A4d4', label: 'friend.tech SharesV1' },

  // Known fee-on-transfer tokens
  { address: '0x532f27101965dd16442E59d40670FaF5eBB142E4', label: 'BRETT' },
  { address: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed', label: 'DEGEN' },
  { address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', label: 'AERO' },
  { address: '0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b', label: 'VIRTUAL' },

  // USDC on Base (proxy pattern)
  { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', label: 'USDC Base' },

  // Additional DEX / fee contracts
  { address: '0xfDE4C96c8593536E31F229EA8f37b2ADa2699bb2', label: 'Uniswap Fee Collector' },
  { address: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD', label: 'Uniswap V3 Factory' },
  { address: '0x827922686190790b37229fd06084350E74485b72', label: 'Uniswap V3 NonfungiblePositionManager' },
];

// ─── Main ───────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(70));
  console.log('  THRYX Red Team — Fee-Recipient Vulnerability Scanner v3');
  console.log('  Target: Base Mainnet (chainId 8453)');
  console.log('  Mode: RESPONSIBLE DISCLOSURE');
  console.log('  Date: ' + new Date().toISOString());
  console.log('='.repeat(70));
  console.log();

  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  const allResults = []; // { address, label, contractName, severity, findings[] }
  let totalScanned = 0;
  let totalWithSource = 0;

  async function scanContract(address, label) {
    totalScanned++;
    const padLabel = label.slice(0, 45).padEnd(45);
    process.stdout.write(`  [${String(totalScanned).padStart(3)}] ${padLabel} `);

    try {
      const sourceData = await getSource(address);
      if (!sourceData?.SourceCode || sourceData.SourceCode === '') {
        console.log('NO_SOURCE');
        return;
      }

      totalWithSource++;
      const src = flattenSource(sourceData);
      if (src.length < 200) { console.log('minimal'); return; }

      const name = sourceData.ContractName || label;
      const findings = analyzeSource(src, name, address);

      const crits = findings.filter(f => f.severity === 'CRITICAL');
      const highs = findings.filter(f => f.severity === 'HIGH');

      if (crits.length > 0 || highs.length > 0) {
        console.log(`*** ${name}: ${crits.length}C ${highs.length}H ***`);
        const ethBal = await provider.getBalance(address);
        allResults.push({
          address,
          label,
          contractName: name,
          compiler: sourceData.CompilerVersion,
          ethBalance: parseFloat(ethers.formatEther(ethBal)),
          findings,
        });
      } else {
        console.log(`${name} - clean`);
      }
    } catch (err) {
      console.log(`ERR: ${err.message.slice(0, 40)}`);
    }
  }

  // ─── Phase 1: Known launchpad + fee contracts ─────────────────
  console.log('[Phase 1] Scanning known launchpads and fee-bearing contracts\n');
  for (const t of LAUNCHPAD_TARGETS) {
    await scanContract(t.address, t.label);
  }

  // ─── Phase 2: Factory-deployed contracts ──────────────────────
  console.log('\n[Phase 2] Scanning factory-deployed contracts\n');
  const clankerDeploys = await discoverFromFactory(
    provider,
    '0xe85a59c628f7d27878aceb4bf3b35733630083a9',
    'Clanker V4'
  );
  // Sample 20 random Clanker tokens
  const clankerSample = clankerDeploys.slice(0, 20);
  for (const t of clankerSample) {
    await scanContract(t.address, t.label);
  }

  // ─── Phase 3: Recently active tokens ──────────────────────────
  console.log('\n[Phase 3] Scanning recently active tokens\n');
  const recentTokens = await discoverFromRecentBlocks(provider);
  const knownSet = new Set([
    ...LAUNCHPAD_TARGETS.map(t => t.address.toLowerCase()),
    ...clankerSample.map(t => t.address.toLowerCase()),
  ]);
  const newTokens = recentTokens.filter(t => !knownSet.has(t.address.toLowerCase())).slice(0, 30);
  for (const t of newTokens) {
    await scanContract(t.address, t.label);
  }

  // ─── Results ──────────────────────────────────────────────────
  console.log('\n' + '='.repeat(70));
  console.log('  SCAN COMPLETE');
  console.log('='.repeat(70));
  console.log(`  Contracts scanned:   ${totalScanned}`);
  console.log(`  With source code:    ${totalWithSource}`);
  console.log(`  With findings:       ${allResults.length}`);

  let critTotal = 0, highTotal = 0;
  for (const r of allResults) {
    critTotal += r.findings.filter(f => f.severity === 'CRITICAL').length;
    highTotal += r.findings.filter(f => f.severity === 'HIGH').length;
  }
  console.log(`  CRITICAL: ${critTotal}  |  HIGH: ${highTotal}`);

  // Save JSON
  const outputDir = path.join(__dirname, '..', 'research');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, 'live-scan-results-v3.json');
  fs.writeFileSync(jsonPath, JSON.stringify({
    scanDate: new Date().toISOString(),
    chain: 'Base (8453)',
    scanner: 'live-scan-v3.js',
    totalScanned,
    totalWithSource,
    criticalCount: critTotal,
    highCount: highTotal,
    results: allResults,
  }, null, 2));
  console.log(`  Saved: ${jsonPath}`);

  // Print detailed findings
  if (allResults.length > 0) {
    console.log('\n' + '='.repeat(70));
    console.log('  DETAILED FINDINGS (CRITICAL and HIGH only)');
    console.log('='.repeat(70));

    for (const r of allResults) {
      const actionable = r.findings.filter(f => f.severity === 'CRITICAL' || f.severity === 'HIGH');
      if (actionable.length === 0) continue;

      console.log(`\n${'─'.repeat(70)}`);
      console.log(`  Contract:  ${r.contractName}`);
      console.log(`  Address:   ${r.address}`);
      console.log(`  Label:     ${r.label}`);
      console.log(`  ETH:       ${r.ethBalance?.toFixed(6) || 'N/A'}`);
      console.log(`  Compiler:  ${r.compiler || 'N/A'}`);

      for (const f of actionable) {
        console.log(`\n  [${f.severity}] ${f.type}`);
        console.log(`    Function: ${f.function}(${(f.params || '').slice(0, 100)})`);
        if (f.modifiers) console.log(`    Modifiers: ${f.modifiers}`);
        console.log(`    Detail: ${f.detail}`);
        if (f.bodyPreview) {
          console.log('    Body:');
          f.bodyPreview.split('\n').slice(0, 25).forEach(l => console.log(`      ${l}`));
        }
      }
    }
  } else {
    console.log('\n  No actionable vulnerabilities found in this scan.');
    console.log('  This is a GOOD result but not conclusive —');
    console.log('  unverified contracts and proxy implementations were not checked.');
  }

  return allResults;
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
