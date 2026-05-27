// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DiamondStorage} from "../diamond/DiamondStorage.sol";
import {AntiMEVStorage} from "./AntiMEVStorage.sol";

/// @title AntiMEVFacet -- Diamond facet exposing anti-MEV controls
/// @author THRYX Research (Ada Lin)
///
/// @notice This facet integrates the anti-MEV system into our existing Diamond
///         proxy architecture.  It provides:
///         1. Admin controls for the anti-MEV hook configuration
///         2. Bot score management (manual override + appeals)
///         3. Statistics and monitoring dashboard
///         4. Revenue claiming for the Diamond owner
///
/// DEPLOYMENT PATH:
///   Diamond.diamondCut(AntiMEVFacet, [selectors], Add)
///   Then call initializeAntiMEV() through the Diamond

contract AntiMEVFacet {
    // ---------------------------------------------------------------
    //  Events
    // ---------------------------------------------------------------
    event AntiMEVInitialized(address treasury, address publicGoodFund);
    event BotScoreOverride(address indexed account, uint8 oldScore, uint8 newScore, string reason);
    event BotScoreAppeal(address indexed account, uint8 oldScore, uint8 newScore);
    event EmergencyPause(bool paused);

    // ---------------------------------------------------------------
    //  Errors
    // ---------------------------------------------------------------
    error NotOwner();
    error NotInitialized();
    error AlreadyInitialized();
    error InvalidInput();

    // ---------------------------------------------------------------
    //  Modifiers
    // ---------------------------------------------------------------
    modifier onlyDiamondOwner() {
        if (msg.sender != DiamondStorage.diamondStorage().contractOwner) revert NotOwner();
        _;
    }

    modifier antiMEVInitialized() {
        if (!AntiMEVStorage.state().config.initialized) revert NotInitialized();
        _;
    }

    // ===============================================================
    //  INITIALIZATION
    // ===============================================================

    /// @notice Initialize anti-MEV system through the Diamond
    /// @param _treasury Address for bot tax revenue
    /// @param _publicGoodFund Address for public good donations
    function initializeAntiMEV(
        address _treasury,
        address _publicGoodFund
    ) external onlyDiamondOwner {
        AntiMEVStorage.State storage s = AntiMEVStorage.state();
        if (s.config.initialized) revert AlreadyInitialized();

        s.config = AntiMEVStorage.Config({
            baseTaxBps:             100,
            botTaxBps:              8000,
            sandwichTaxBps:         9500,
            sniperTaxBps:           8000,
            sniperFloorBps:         500,
            sniperWindowBlocks:     50,
            sameBuySellBlockPenalty: 80,
            gasThresholdGwei:       5,
            minHoldBlocks:          15,
            poolInitBlock:          uint64(block.number),
            lastConfigUpdate:       uint64(block.timestamp),
            treasury:               _treasury,
            lpRewardPool:           _treasury,
            treasuryShareBps:       7000,
            publicGoodBps:          10,
            publicGoodFund:         _publicGoodFund,
            owner:                  msg.sender,
            initialized:            true
        });

        s.decoyFeeRecipient = address(this);
        s.realFeeRecipient = _treasury;

        emit AntiMEVInitialized(_treasury, _publicGoodFund);
    }

    // ===============================================================
    //  BOT SCORE MANAGEMENT
    // ===============================================================

    /// @notice Manually override a bot score (for false positives or confirmed bots)
    function setBotScore(
        address _account,
        uint8 _score,
        string calldata _reason
    ) external onlyDiamondOwner antiMEVInitialized {
        AntiMEVStorage.AddressProfile storage p = AntiMEVStorage.state().profiles[_account];
        uint8 old = p.botScore;
        p.botScore = _score;
        emit BotScoreOverride(_account, old, _score, _reason);
    }

    /// @notice Allow an address to appeal their bot score
    /// @dev The appeal reduces the score by half, minimum once per 100 blocks.
    ///      This prevents permanent false positives while still making it
    ///      expensive for actual bots (they re-accumulate score immediately).
    function appealBotScore() external antiMEVInitialized {
        AntiMEVStorage.AddressProfile storage p = AntiMEVStorage.state().profiles[msg.sender];
        if (p.botScore == 0) revert InvalidInput();

        // Rate limit: can only appeal once per 100 blocks (~200 seconds)
        uint64 blocksSinceLastSell = uint64(block.number) - p.lastSellBlock;
        require(blocksSinceLastSell >= 100, "Too soon to appeal");

        uint8 old = p.botScore;
        p.botScore = old / 2; // halve the score
        emit BotScoreAppeal(msg.sender, old, p.botScore);
    }

    /// @notice Batch-whitelist addresses (for known good actors: DEX aggregators, etc.)
    function batchWhitelist(
        address[] calldata _accounts,
        bool _status
    ) external onlyDiamondOwner antiMEVInitialized {
        AntiMEVStorage.State storage s = AntiMEVStorage.state();
        for (uint256 i = 0; i < _accounts.length; i++) {
            s.profiles[_accounts[i]].whitelisted = _status;
        }
    }

    // ===============================================================
    //  CONFIGURATION
    // ===============================================================

    /// @notice Update all tax rates in a single call
    function updateTaxConfig(
        uint16 _baseTaxBps,
        uint16 _botTaxBps,
        uint16 _sandwichTaxBps,
        uint16 _sniperTaxBps,
        uint16 _sniperFloorBps
    ) external onlyDiamondOwner antiMEVInitialized {
        if (_baseTaxBps > 1000) revert InvalidInput(); // max 10%
        if (_botTaxBps > 9900) revert InvalidInput();
        if (_sandwichTaxBps > 9900) revert InvalidInput();
        if (_sniperTaxBps > 9900) revert InvalidInput();
        if (_sniperFloorBps > _sniperTaxBps) revert InvalidInput();

        AntiMEVStorage.Config storage cfg = AntiMEVStorage.state().config;
        cfg.baseTaxBps = _baseTaxBps;
        cfg.botTaxBps = _botTaxBps;
        cfg.sandwichTaxBps = _sandwichTaxBps;
        cfg.sniperTaxBps = _sniperTaxBps;
        cfg.sniperFloorBps = _sniperFloorBps;
        cfg.lastConfigUpdate = uint64(block.timestamp);
    }

    /// @notice Update detection thresholds
    function updateDetectionConfig(
        uint64 _sniperWindowBlocks,
        uint64 _sameBuySellBlockPenalty,
        uint256 _gasThresholdGwei,
        uint256 _minHoldBlocks
    ) external onlyDiamondOwner antiMEVInitialized {
        AntiMEVStorage.Config storage cfg = AntiMEVStorage.state().config;
        cfg.sniperWindowBlocks = _sniperWindowBlocks;
        cfg.sameBuySellBlockPenalty = _sameBuySellBlockPenalty;
        cfg.gasThresholdGwei = _gasThresholdGwei;
        cfg.minHoldBlocks = _minHoldBlocks;
        cfg.lastConfigUpdate = uint64(block.timestamp);
    }

    /// @notice Update revenue routing
    function updateRevenueConfig(
        address _treasury,
        address _lpRewardPool,
        uint16 _treasuryShareBps,
        uint16 _publicGoodBps,
        address _publicGoodFund
    ) external onlyDiamondOwner antiMEVInitialized {
        if (_treasuryShareBps > 10000) revert InvalidInput();
        if (_publicGoodBps > 1000) revert InvalidInput(); // max 10%

        AntiMEVStorage.Config storage cfg = AntiMEVStorage.state().config;
        cfg.treasury = _treasury;
        cfg.lpRewardPool = _lpRewardPool;
        cfg.treasuryShareBps = _treasuryShareBps;
        cfg.publicGoodBps = _publicGoodBps;
        cfg.publicGoodFund = _publicGoodFund;
    }

    // ===============================================================
    //  MONITORING / DASHBOARD
    // ===============================================================

    /// @notice Get the full anti-MEV system configuration
    function getAntiMEVConfig() external view returns (
        uint16 baseTaxBps,
        uint16 botTaxBps,
        uint16 sandwichTaxBps,
        uint16 sniperTaxBps,
        uint16 sniperFloorBps,
        uint64 sniperWindowBlocks,
        uint256 gasThresholdGwei,
        uint256 minHoldBlocks,
        address treasury,
        address publicGoodFund
    ) {
        AntiMEVStorage.Config storage cfg = AntiMEVStorage.state().config;
        return (
            cfg.baseTaxBps,
            cfg.botTaxBps,
            cfg.sandwichTaxBps,
            cfg.sniperTaxBps,
            cfg.sniperFloorBps,
            cfg.sniperWindowBlocks,
            cfg.gasThresholdGwei,
            cfg.minHoldBlocks,
            cfg.treasury,
            cfg.publicGoodFund
        );
    }

    /// @notice Get cumulative statistics
    function getAntiMEVStats() external view returns (
        uint256 totalBotTax,
        uint256 totalSandwichTax,
        uint256 totalSniperTax,
        uint256 totalRegularTax,
        uint256 botsDetected,
        uint256 sandwichesDetected
    ) {
        AntiMEVStorage.State storage s = AntiMEVStorage.state();
        return (
            s.totalBotTaxCollected,
            s.totalSandwichTaxCollected,
            s.totalSniperTaxCollected,
            s.totalRegularTaxCollected,
            s.botsDetected,
            s.sandwichesDetected
        );
    }

    /// @notice Get a single address's bot profile
    function getAddressProfile(address _account) external view returns (
        uint64 firstSeenBlock,
        uint64 lastBuyBlock,
        uint64 lastSellBlock,
        uint32 buyCount,
        uint32 sellCount,
        uint8 botScore,
        bool whitelisted,
        bool isBotClassified
    ) {
        AntiMEVStorage.AddressProfile storage p = AntiMEVStorage.state().profiles[_account];
        return (
            p.firstSeenBlock,
            p.lastBuyBlock,
            p.lastSellBlock,
            p.buyCount,
            p.sellCount,
            p.botScore,
            p.whitelisted,
            p.botScore >= 128
        );
    }
}
