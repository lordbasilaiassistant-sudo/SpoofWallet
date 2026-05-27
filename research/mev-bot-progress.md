# MEV Bot Progress — 2026-05-27

## What Works
- SandwichAttacker contract compiles and executes on Base fork
- V4 swap flow: swap → settle → take with BalanceDelta decoding
- collectRewards IS permissionless (confirmed on fork)
- Fee conversion DOES happen during collectRewards (FeesSwapped event confirmed)
- Full round-trip: WETH→token→WETH completes without revert

## What Doesn't Work Yet
- Round-trip cost (~7% on MCPLT, ~2.4% on CREAO) exceeds sandwich profit
- The fee conversion during collectRewards is tiny relative to our swap size
- Need to sandwich the AUTOMATIC fee conversion during USER swaps, not manual collectRewards

## Key Addresses Found

### High-Volume Tokens (fee generators)
- MCPLT: 0x0c09DB63f63f08C2438da91e9B38E5CDe7B68B07 (54 recent transfers, 0.028 WETH single conversion)
- #SaveTheSealions: 0x4e07294bc53dbf862fe52ba50bc2194cc52fdcb6 (365 transfers)
- WORLDCUP: 0x790fe41f92a5299369af8f95448534a4c12e6839 (257 transfers)

### Hooks
- 0xb429d62f8f3bFFb98CdB9569533eA23bF0Ba28CC — ClankerHookDynamicFeeV2 (burnout, MCPLT, most tokens)
- 0xd60D6B218116cFd801E28F78d011a203D2b068Cc — ClankerHookStaticFee (CREAO)

### Infrastructure
- Locker: 0x63D2DfEA64b3433F4071A98665bcD7Ca14d93496 (198 events/200 blocks)
- Fee Locker: 0xF3622742b1E446D92e45E22923Ef11C2fcD55D68 (432 WETH)
- PoolManager: 0x498581fF718922c3f8e6A244956aF099B2652b2b
- Wrapper: 0xcF5CeD0e8b26C64cB032d0538Bb29E384c4BFF3b
- MEV Module: 0xebB25BB797D82CB78E1bc70406b13233c0854413
- Morpho: 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb (65K WETH)

### PoolKeys
- CREAO/WETH: c0=WETH, c1=CREAO, fee=0x800000, ts=200, hook=0xd60D...68CC
- MCPLT/WETH: c0=MCPLT, c1=WETH, fee=0x800000, ts=200, hook=0xb429...28CC

### Fee Flow
- 198 StoreTokens events per 200 blocks from locker
- Biggest single WETH conversion: 0.028 WETH
- Top fee owner uncollected: 1.279 WETH (0x640960Ee...)
- 12 WETH/day total throughput in fee conversions

## Next Steps
1. The real sandwich targets the AUTOMATIC fee conversion during user swaps, not manual collectRewards
2. Need mempool monitoring to frontrun/backrun user swaps
3. OR: find a way to profitably call collectRewards where conversion > round-trip fee cost
4. Consider lower-fee pools or different token pairs
5. The fee conversion only profits us if it moves the price MORE than our round-trip cost
