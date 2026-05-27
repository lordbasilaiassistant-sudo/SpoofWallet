# 26 -- Anti-MEV Token: Design Document

**Date**: 2026-05-27
**Author**: Ada Lin (ML Research Scientist, THRYX)
**Status**: DESIGN COMPLETE, UNDEPLOYED
**Contracts**: `contracts/anti-mev/`

---

## 0. Falsifiable Hypothesis

**H1**: A Uniswap V4 hook can detect and differentially tax MEV bots (sandwich attackers, frontrunners, snipers) in real-time using only on-chain signals, with a false-positive rate below 5% on regular traders and a true-positive rate above 80% on known bot patterns.

**What would falsify this**: If the detection signals (same-block buy+sell, contract caller, gas anomaly, hold time) produce >5% false positives on a sample of 1000 organic Base mainnet swaps, OR if bots can trivially bypass all 6 signals simultaneously with <10% overhead.

---

## 1. Problem Statement

MEV extraction on Base and Ethereum costs regular traders an estimated $50M+ annually (HYPOTHESIS -- no single authoritative source; Flashbots MEV-Explore tracked ~$700M extracted on L1 through 2023, L2 numbers less certain). The three primary attack vectors are:

1. **Sandwich attacks**: Bot buys before victim, victim's buy moves price up, bot sells at profit. Victim gets worse execution.
2. **Frontrunning**: Bot copies a pending trade and executes it first at a better price.
3. **Sniping**: Bot buys a new token in the same block as pool creation, before any organic buyers.

Current defenses (Flashbots Protect, private mempools, MEV-Share) operate at the infrastructure layer. They require users to opt in and do not punish the attacker -- they just try to hide the victim's transaction.

This design takes a different approach: **make the token itself hostile to bots**. Instead of hiding from MEV, we tax it so heavily that the expected value of attacking this token is negative.

---

## 2. Architecture Overview

```
                   +-------------------+
                   | Uniswap V4        |
                   | PoolManager       |
                   +--------+----------+
                            |
                   beforeSwap / afterSwap
                            |
                   +--------v----------+
                   | AntiMEVHook       |  <-- Bot detection engine
                   | (V4 Hook)         |      6-signal scoring
                   |                   |      Dynamic fee override
                   +--------+----------+
                            |
              +-------------+-------------+
              |                           |
    +---------v---------+       +---------v---------+
    | AntiMEVToken      |       | AntiMEVTreasury   |
    | (ERC-20)          |       | (Revenue mgmt)    |
    |                   |       |                   |
    | Transfer-level    |       | Auto-buyback      |
    | bot detection     |       | Public good fund  |
    | Score inheritance |       | Burn / reflect    |
    +-------------------+       +-------------------+
              |
    +---------v---------+
    | AntiMEVFacet      |  <-- Optional: Diamond integration
    | (Diamond proxy)   |      Admin controls
    +-------------------+      Bot score management
                               Monitoring dashboard
```

### Contract inventory

| Contract | File | Purpose | Size est. |
|----------|------|---------|-----------|
| AntiMEVStorage | `AntiMEVStorage.sol` | Diamond-compatible isolated storage | ~80 lines |
| AntiMEVHook | `AntiMEVHook.sol` | V4 hook: detection + dynamic fee | ~380 lines |
| AntiMEVToken | `AntiMEVToken.sol` | ERC-20 with transfer-level taxation | ~220 lines |
| AntiMEVTreasury | `AntiMEVTreasury.sol` | Revenue collection + auto-buyback | ~200 lines |
| AntiMEVFacet | `AntiMEVFacet.sol` | Diamond facet for admin integration | ~220 lines |
| IAntiMEVHook | `IAntiMEVHook.sol` | Interface for cross-contract calls | ~25 lines |

---

## 3. Detection System: 6-Signal Bot Scoring

Each address has a `botScore` (uint8, 0-255). Score >= 128 = classified as bot. Scores accumulate across interactions and never naturally decay (intentional -- bots should not be able to wait out a score).

### Signal Table

| # | Signal | Score | Rationale | Bypass difficulty |
|---|--------|-------|-----------|-------------------|
| 1 | Same-block buy+sell | +80 | No human does this. Definitive sandwich/arb signal. | HIGH -- requires splitting across blocks, reducing profit |
| 2 | Contract caller (extcodesize > 0) | +40 | Most bots are contracts. EOAs with EIP-7702 delegations also trigger, hence moderate weight. | MEDIUM -- can use EOA, but loses atomicity |
| 3 | Gas price > threshold | +30 | Base gas is typically <0.01 gwei. Bots use priority fees to land in specific block positions. | LOW -- can use normal gas, but loses block-position control |
| 4 | Sniper (first interaction in sniper window) | +60 | Buying within 50 blocks (~100s) of pool init with no prior history = almost certainly a bot. | HIGH -- must wait, missing the sniper window entirely |
| 5 | Fast sell (sell within minHoldBlocks of last buy) | +20 | Humans rarely sell within 30 seconds of buying. | MEDIUM -- can hold longer, reducing capital efficiency |
| 6 | Sandwich pattern (first buyer in block, 2+ swaps, then sells) | immediate 95% tax | Block-level heuristic. If you bought first, others bought after, and you sell in the same block, that is a sandwich. | HIGH -- requires spreading across blocks, eliminating sandwich profit |

### Composite scoring example

A sandwich bot in block N:
- Buys first in block: no immediate score (buy is not penalized per se)
- Is a contract: +40
- Uses high gas to land first: +30
- Pool is 10 blocks old: +60 (sniper)
- Sells in same block as buy: +80
- **Total: 210 -> bot classified**
- Sell leg: **95% sandwich tax** (overrides the 80% bot tax)

A regular human trader:
- Buys via MetaMask (EOA): +0
- Normal gas: +0
- Pool is 200 blocks old: +0
- Sells 500 blocks later: +0
- **Total: 0 -> 1% base tax**

### False positive analysis

The most likely false positive is an EOA user who:
1. Buys and sells in the same block (via a DEX aggregator that batches)
2. Uses a smart wallet (EIP-7702)

For case (1): same-block buy+sell = +80, which is below the 128 threshold. They would need another signal to be classified as a bot. A smart wallet adds +40 = 120, still below threshold. Only if they ALSO use high gas (+30 = 150) would they be falsely classified.

MITIGATION: Known DEX aggregators and smart wallet factories are whitelisted. The appeal mechanism (halves score, rate-limited) provides a recovery path.

---

## 4. Tax System

### Tax tiers

| Condition | Tax (bps) | Tax (%) | When |
|-----------|-----------|---------|------|
| Normal trade | 100 | 1% | Default for all swaps |
| Sniper (block 0) | 8000 | 80% | At pool init, linearly decays |
| Sniper (block 25/50) | 4250 | 42.5% | Midway through window |
| Sniper (block 50) | 500 | 5% | Floor after window |
| Bot classified | 8000 | 80% | botScore >= 128 |
| Sandwich sell | 9500 | 95% | Detected same-block pattern |

### Sniper tax decay curve

```
Tax%
80% |*
    | *
    |  *
    |   *
    |    *
    |     *
    |      *
    |       *
    |        *
    |         *
 5% |          *__________________
    +--+--+--+--+--+--+--+--+--+--> blocks
    0  5  10 15 20 25 30 35 40 50
```

Linear decay from `sniperTaxBps` (8000) to `sniperFloorBps` (500) over `sniperWindowBlocks` (50). This is similar to Clanker V4's existing mechanism but with a longer window (50 blocks vs ~7.5 blocks) and a higher floor (5% vs ~1%).

### Why 80% bot tax, not 100%

100% tax = the swap reverts or produces 0 output. Bots detect this immediately (via `eth_call` simulation) and simply skip the token. At 80%, the bot still receives 20% of expected output -- enough to look like "bad slippage" rather than "honeypot." This keeps bots coming back and generating revenue.

HYPOTHESIS: 80% is the optimal "boiling frog" rate. Too high and bots blacklist immediately. Too low and bots still profit. This needs empirical validation on mainnet.

---

## 5. Sandwich Trap (detailed mechanism)

### How a normal sandwich works

```
Block N:
  tx 0: Bot buys TOKEN (pushes price up)
  tx 1: Victim buys TOKEN (at higher price)
  tx 2: Bot sells TOKEN (at even higher price, profits from victim's price impact)
```

### How our trap works

```
Block N:
  tx 0: Bot buys TOKEN
    -> beforeSwap records: blockStates[N].firstBuyer = bot
    -> beforeSwap records: blockStates[N].swapCountInBlock = 1
    -> Tax: depends on bot's existing score (could be sniper/bot/normal)

  tx 1: Victim buys TOKEN
    -> beforeSwap records: blockStates[N].swapCountInBlock = 2
    -> Tax: normal 1%

  tx 2: Bot sells TOKEN
    -> beforeSwap checks: sender == blockStates[N].firstBuyer? YES
    -> beforeSwap checks: swapCountInBlock >= 2? YES
    -> SANDWICH DETECTED
    -> Tax: 95% on the sell leg
    -> Bot's profit is destroyed. The 95% tax exceeds the sandwich spread.
```

### Why this works against sophisticated bots

A bot simulating the sandwich via `eth_call`:
- The buy simulation succeeds (normal or moderate tax)
- The sell simulation ALSO succeeds (it returns 5% of expected output)
- But the bot's profit calculation: `sell_proceeds - buy_cost` is deeply negative at 95% sell tax
- Smart bots will detect this. Dumb bots will execute and lose.

A bot that splits across blocks to avoid detection:
- Buy in block N, sell in block N+1
- This bypasses the sandwich detector
- BUT: if block N+1 is within `minHoldBlocks` (15 blocks), the fast-sell penalty (+20 score) applies
- And the bot still has same-block or contract-caller signals
- Net effect: the bot must hold for 30+ seconds, during which the price can move against them. This eliminates the sandwich profit model entirely (sandwiches work because of atomic same-block execution).

---

## 6. Frontrun Honeypot (detailed mechanism)

### Decoy functions

The hook contract exposes three functions that look exploitable:

#### 6a. `setFeeRecipient(address)` -- payable, no access control

Bots scanning for `setFeeRecipient` patterns (common in fee-on-transfer tokens) will find this function. It requires `msg.value > 0`, which looks like a "weak" guard. Bot sends minimum ETH, calls the function, and thinks it has redirected fees.

**Reality**: This only sets `decoyFeeRecipient`, not `realFeeRecipient`. All actual fee revenue flows through the V4 hook's `lpFeeOverride`, which the bot cannot intercept. The bot's ETH is forwarded to the real treasury.

#### 6b. `withdrawFees()` -- no access control

Looks like a classic "anyone can withdraw" bug. Bots will call this hoping to drain fees.

**Reality**: This withdraws the contract's raw ETH balance (which is typically dust from honeypot interactions). Even if non-zero, it goes to `realFeeRecipient`, not the caller. Bot wastes gas.

#### 6c. `emergencyWithdraw(address, uint256)` -- no access control

Looks like the holy grail: an unguarded emergency withdraw function. Bots will absolutely try to call this.

**Reality**: Does NOT transfer anything. Instead, it adds +100 to the caller's bot score and emits an event. The bot is now permanently classified as a bot (score 100 + any other signals = well over 128). All future interactions with this token are taxed at 80%.

### Bot scanner response

MEV bots use automated scanners that:
1. Decompile bytecode to find selectors
2. Look for patterns: `setFeeRecipient`, `withdraw`, `emergencyWithdraw`
3. Simulate calls to check if they succeed
4. If successful, add to exploit queue

Our decoy functions:
- Have recognizable selectors (matching common patterns)
- Succeed when simulated (no revert)
- Appear to do what the bot expects (state changes, ETH movements)
- But the state changes are to decoy variables, and the ETH goes to our treasury

---

## 7. MEV-Resistant Pool Design

### 7a. Dynamic fee spike on volatility

The V4 hook's `beforeSwap` returns a `lpFeeOverride`. Beyond the bot-detection tax, the fee should spike when rapid price movement is detected (bot-induced or otherwise).

Implementation approach (not yet in contracts, marked HYPOTHESIS):
- Track a simple EMA of swap sizes over the last N swaps
- If the current swap is >3x the EMA, add a volatility surcharge
- This makes large-swap sandwiches even more expensive

### 7b. TWAP oracle protection

The treasury's auto-buyback uses `amountOutMinimum: 0` currently (marked as TODO). The production version should:
1. Maintain a time-weighted average price (TWAP) from the V4 pool
2. Set `amountOutMinimum` to `twapPrice * (1 - maxSlippageBps/10000)`
3. If the current spot price deviates >3% from TWAP, skip the buyback

This prevents attackers from manipulating the price in one block and then triggering the buyback to extract value.

### 7c. Tick-range liquidity strategy

HYPOTHESIS (not implemented -- requires off-chain LP management):
- Concentrate liquidity in narrow tick ranges around the TWAP
- This makes sandwich math harder because the price impact function is steeper
- Attacker needs more capital to move the price the same distance
- Trade-off: narrow ranges mean more impermanent loss if price trends

---

## 8. Revenue Model

### Flow diagram

```
Bot tax (80%)  ----+
                   |     +---> 69.93% --> Treasury (auto-buyback)
Sandwich tax (95%) +---->|
                   |     +---> 29.97% --> LP Reward Pool
Sniper tax (var)   +     +---> 0.10%  --> Public Good Fund
                   |
                   v
           Total bot revenue
```

### Auto-buyback mechanics (AntiMEVTreasury)

1. Revenue accumulates in the treasury as WETH
2. When balance exceeds `buybackThreshold` (0.01 ETH), anyone can call `executeBuyback()`
3. Buyback is rate-limited (10 blocks between calls) to prevent manipulation
4. Buyback amount is capped at `maxBuybackPerTx` (0.1 ETH) to limit price impact
5. TWAP protection prevents buying at manipulated prices
6. Bought tokens are burned (default), reflected to holders, or added to LP

### Revenue projection (HYPOTHESIS)

Assuming:
- Token has $50k daily volume
- 10% of volume is bot activity ($5k/day)
- Average bot tax rate: 85% (mix of 80% and 95%)
- Bot revenue: $4,250/day
- Treasury share (70%): $2,975/day in buyback pressure
- Public good (0.1%): $4.25/day

At $500k daily volume, numbers 10x. These are hypothetical and depend entirely on how many bots engage.

---

## 9. Deployment Options

### Option A: Clanker V4 Factory

**Pros**: Immediate visibility on Clanker ecosystem, automatic LP locking, fee infrastructure, bot-visible on DEX Screener.
**Cons**: Must conform to Clanker's hook registration system. The hook address must have the correct flag bits in its address (V4 requirement). Clanker may not support custom hooks on their factory.

**Deployment cost**: ~$0.06 (Clanker factory fee) + hook deployment gas (~0.002 ETH on Base)

Steps:
1. Deploy AntiMEVHook with correct address flags (requires CREATE2 mining)
2. Deploy AntiMEVToken
3. Call Clanker factory with our hook address
4. Deploy AntiMEVTreasury pointing to the pool

### Option B: Standalone with Diamond Proxy

**Pros**: Full control, can integrate with existing Diamond, no dependency on Clanker.
**Cons**: No automatic Clanker ecosystem visibility, must bootstrap liquidity manually.

Steps:
1. Deploy AntiMEVHook (CREATE2 for address flags)
2. Add AntiMEVFacet to existing Diamond via `diamondCut`
3. Call `initializeAntiMEV()` through Diamond
4. Deploy AntiMEVToken as standalone or as a Diamond facet (ERC20Facet replacement)
5. Initialize V4 pool directly via PoolManager
6. Deploy AntiMEVTreasury

### Option C: Hybrid

Deploy token via Clanker (visibility) but use Diamond for treasury management and admin controls. This gets the best of both worlds but adds complexity.

---

## 10. Security Considerations

### 10a. What could go wrong

| Risk | Severity | Mitigation |
|------|----------|------------|
| False positive on DEX aggregator | HIGH | Whitelist known aggregators (1inch, Paraswap, Cowswap router addresses on Base) |
| Bot score inheritance punishes innocent receiver | MEDIUM | Only inherits if sender score >= 64 AND inherited score > recipient's current score |
| Admin key compromise changes all tax rates to 0 | HIGH | Use Diamond with timelock on config changes (not yet implemented) |
| Bots blacklist token immediately | MEDIUM | 80% tax (not 100%) keeps them engaged; decoy functions provide ongoing revenue from scanners |
| Treasury buyback is frontrun | MEDIUM | Rate limiting + TWAP protection + max amount cap |
| Gas overhead makes swaps too expensive | LOW | All detection is O(1) -- no loops, no array scans. Estimated overhead: ~20k gas per swap |

### 10b. Ethical considerations

This system is designed to be transparent. The contract source is verified and readable. It does not:
- Prevent anyone from trading (even bots can trade, they just pay 80% tax)
- Lock funds (no blacklisting, no freeze function)
- Rug pull (treasury cannot withdraw WETH -- it MUST be used for buyback)
- Hide its nature (no proxy obfuscation of the tax mechanism)

The decoy functions are arguably deceptive, but they target entities that are themselves attempting to exploit what they believe is a vulnerability. The ethical framing: if you are scanning contracts for exploitable functions, you are an attacker, and the decoy is a defensive measure.

### 10c. Known limitations

1. **Block-level detection is imperfect**: If a bot uses Flashbots-style private transactions on Base, we cannot see the ordering until it is committed. The hook only sees the final block state.

2. **extcodesize is bypassable**: A bot calling from a constructor has extcodesize == 0. This is why it is one signal among six, not a sole detector. (See EIP-7702 note in contracts.)

3. **Gas threshold is chain-specific**: The 5 gwei threshold works for Base (where typical gas is <0.01 gwei) but would cause false positives on Ethereum mainnet. Config must be adjusted per chain.

4. **No cross-pool detection**: A bot could buy on one pool and sell on another (if the token has multiple pools). The hook only sees swaps in its own pool. Cross-pool sandwiches are out of scope.

5. **Score persistence**: Bot scores never decay. This is intentional (to prevent bots from waiting out their score) but means a false positive is sticky. The appeal mechanism (halves score per appeal, rate-limited) is the mitigation.

---

## 11. Test Plan

### Unit tests (TODO)

1. Deploy hook + token + treasury on Anvil fork of Base
2. Simulate normal swap: verify 1% tax, score remains 0
3. Simulate same-block buy+sell: verify score >= 80, tax = 80%
4. Simulate sandwich (3-tx block): verify 95% tax on sell leg
5. Simulate sniper buy at block 0: verify 80% tax
6. Simulate sniper buy at block 25: verify ~42% tax
7. Simulate sniper buy at block 50+: verify 5% -> 1% transition
8. Call decoy `emergencyWithdraw`: verify score += 100, no transfer
9. Call decoy `setFeeRecipient`: verify ETH goes to real treasury
10. Whitelist an address: verify 0% tax
11. Trigger auto-buyback: verify WETH -> TOKEN swap + burn

### Integration tests (TODO)

1. Fork Base mainnet with actual V4 PoolManager
2. Deploy full system
3. Simulate 100 organic swaps + 20 bot swaps
4. Measure false positive rate (target: <5%)
5. Measure bot detection rate (target: >80%)
6. Measure gas overhead per swap (target: <30k additional gas)

### Mainnet validation (TODO)

1. Deploy with minimal liquidity ($50 worth of WETH)
2. Monitor for 48 hours
3. Analyze all interactions for false positives
4. Adjust thresholds based on real data
5. Scale up liquidity if results are positive

---

## 12. Comparison to Prior Art

| Project | Approach | Limitation | Our improvement |
|---------|----------|------------|-----------------|
| Clanker V4 sniper tax | 80%->5% decay over 15s | Bots adapted by waiting 15s | Longer window (100s), multi-signal scoring |
| Flashbots Protect | Private mempool | Requires user opt-in | Automatic, on-chain |
| MEV-Share | Rebates | Complex infrastructure | Simple hook, no infrastructure |
| Anti-bot tokens (generic) | Buy cooldown, max wallet | Hurts all users equally | Targeted: only bots pay the tax |
| Honeypot tokens | Prevent selling | Unethical, rug pull | Not a honeypot: bots CAN sell, at 80% tax |

---

## 13. Open Questions

1. **Optimal bot tax rate**: Is 80% the right rate? Too high and bots avoid immediately, too low and they still profit. Needs A/B testing with different rates on different tokens. (HYPOTHESIS: 70-85% range is optimal.)

2. **Score decay**: Should bot scores decay very slowly (e.g., -1 per 1000 blocks)? Current design: no decay. Trade-off between false positive recovery and bot wallet cycling.

3. **Cross-pool coordination**: If the token has pools on multiple DEXes, should the hook coordinate bot scores across pools? Possible via a shared storage contract, but adds complexity.

4. **Clanker factory compatibility**: Does Clanker V4 factory allow custom hooks? If not, standalone deployment is the only option. Need to check the factory's `createToken` function for hook validation.

5. **V4 hook address mining**: V4 requires hooks to have specific bits set in their address (e.g., bit 0 = beforeInitialize, bit 6 = beforeSwap, bit 7 = afterSwap). Need to mine a CREATE2 salt that produces an address with bits 0, 6, and 7 set. This is computationally cheap (minutes on a modern GPU).

---

## 14. File Manifest

```
contracts/anti-mev/
  AntiMEVStorage.sol     -- Diamond-compatible isolated storage
  IAntiMEVHook.sol       -- Interface for the V4 hook
  AntiMEVHook.sol        -- Core: V4 hook with 6-signal bot detection
  AntiMEVToken.sol       -- ERC-20 with transfer-level bot taxation
  AntiMEVTreasury.sol    -- Revenue collection + auto-buyback
  AntiMEVFacet.sol       -- Diamond proxy facet for admin integration
```

---

## 15. Next Steps (ordered by validation priority)

1. **20-line test**: Simulate a sandwich on Anvil to verify the hook detects it. If this fails, the entire design is wrong.
2. **Gas benchmark**: Measure the gas overhead of the 6-signal detection in beforeSwap. If >50k additional gas, simplify.
3. **Mine hook address**: Use CREATE2 brute-force to find an address with the correct V4 flag bits.
4. **Testnet deployment**: Deploy on Base Sepolia, run the full test plan.
5. **Mainnet deployment**: Deploy with minimal liquidity, monitor 48h, iterate.
