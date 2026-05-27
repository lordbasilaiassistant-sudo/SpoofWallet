// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title AntiMEVStorage -- Diamond-compatible storage for anti-MEV token system
/// @notice Isolated storage slots prevent collision with other facets.
///         Every mapping/struct here is designed for O(1) bot detection.
library AntiMEVStorage {
    bytes32 constant ANTI_MEV_POSITION = keccak256("thryx.antimev.storage.v1");

    // ---------------------------------------------------------------
    //  Per-address behaviour tracking (fits in 2 slots)
    // ---------------------------------------------------------------
    struct AddressProfile {
        uint64  firstSeenBlock;       // block.number of first interaction
        uint64  lastBuyBlock;         // block.number of most recent buy
        uint64  lastSellBlock;        // block.number of most recent sell
        uint32  buyCount;             // lifetime buy count
        uint32  sellCount;            // lifetime sell count
        uint256 cumulativeBuyWei;     // total WETH spent buying
        uint256 cumulativeSellWei;    // total WETH received selling
        uint8   botScore;             // 0-255, >=128 = treated as bot
        bool    whitelisted;          // exempt from all taxes
    }

    // ---------------------------------------------------------------
    //  Per-block sandwich detection state
    // ---------------------------------------------------------------
    struct BlockState {
        address firstBuyer;           // first buyer in this block
        uint256 firstBuyAmount;       // amount of first buy
        uint128 swapCountInBlock;     // how many swaps so far this block
        bool    sandwichFlagged;      // if a sandwich pattern was detected
    }

    // ---------------------------------------------------------------
    //  Global config
    // ---------------------------------------------------------------
    struct Config {
        // Tax rates (basis points)
        uint16 baseTaxBps;            // normal tax, e.g. 100 = 1%
        uint16 botTaxBps;             // tax on detected bots, e.g. 8000 = 80%
        uint16 sandwichTaxBps;        // tax on sandwich sell leg, e.g. 9500 = 95%
        uint16 sniperTaxBps;          // initial sniper tax, e.g. 8000 = 80%
        uint16 sniperFloorBps;        // sniper tax floor after decay, e.g. 500 = 5%

        // Detection thresholds
        uint64 sniperWindowBlocks;    // blocks after pool init where sniper tax applies
        uint64 sameBuySellBlockPenalty;// extra botScore for same-block buy+sell
        uint256 gasThresholdGwei;     // gas price above this adds to botScore
        uint256 minHoldBlocks;        // minimum blocks between buy and sell for non-bot

        // Timing
        uint64 poolInitBlock;         // block.number when pool was initialized
        uint64 lastConfigUpdate;      // timestamp of last config change

        // Revenue routing
        address treasury;             // receives bot taxes
        address lpRewardPool;         // optional: reflect to LP holders
        uint16 treasuryShareBps;      // % of bot tax to treasury (rest to LP)
        uint16 publicGoodBps;         // 0.1% = 10 bps of bot tax to public good fund
        address publicGoodFund;       // public good recipient

        // Admin
        address owner;                // can update config
        bool initialized;
    }

    // ---------------------------------------------------------------
    //  Root state
    // ---------------------------------------------------------------
    struct State {
        Config config;
        mapping(address => AddressProfile) profiles;
        mapping(uint256 => BlockState) blockStates; // block.number => state
        // Decoy / honeypot state
        address decoyFeeRecipient;    // the "vulnerable" recipient bots see
        address realFeeRecipient;     // where fees actually go
        uint256 totalBotTaxCollected; // lifetime bot tax in WETH
        uint256 totalSandwichTaxCollected;
        uint256 totalSniperTaxCollected;
        uint256 totalRegularTaxCollected;
        // Cumulative stats
        uint256 botsDetected;
        uint256 sandwichesDetected;
    }

    function state() internal pure returns (State storage s) {
        bytes32 pos = ANTI_MEV_POSITION;
        assembly {
            s.slot := pos
        }
    }
}
