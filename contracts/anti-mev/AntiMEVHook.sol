// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AntiMEVStorage} from "./AntiMEVStorage.sol";
import {IAntiMEVHook} from "./IAntiMEVHook.sol";

/// @title AntiMEVHook -- Uniswap V4 Hook that detects and taxes MEV bots
/// @author THRYX Research (Ada Lin)
///
/// @notice This hook implements beforeSwap / afterSwap callbacks compatible with
///         Uniswap V4's IHooks interface.  It uses a multi-signal bot detection
///         system and applies punitive taxes on detected bot behaviour while
///         leaving regular traders essentially untaxed.
///
/// DETECTION SIGNALS (each adds to an address's botScore):
///   1. Same-block buy+sell          (+80 score, nearly guaranteed bot)
///   2. Contract caller (no EOA)     (+40 score)
///   3. Gas price > threshold        (+30 score)
///   4. First interaction = sniper   (+60 score during sniper window)
///   5. Sell within minHoldBlocks    (+20 score)
///   6. Sandwich pattern detection   (immediate 95% tax on sell leg)
///
/// TAX APPLICATION:
///   - botScore >= 128 => botTaxBps (default 80%)
///   - Sandwich sell leg => sandwichTaxBps (default 95%)
///   - Sniper window => sniperTaxBps decaying to sniperFloorBps
///   - Normal => baseTaxBps (default 1%)
///
/// TAX REVENUE FLOW:
///   - treasuryShareBps% => treasury (auto-buyback)
///   - remainder => LP reward pool
///   - publicGoodBps of total => public good fund
///
/// DESIGN CONSTRAINTS:
///   - All detection is on-chain, no oracle dependency
///   - O(1) per-swap gas overhead (no loops, no array iteration)
///   - Compatible with Clanker V4 factory deployment
///   - Compatible with standalone deployment via Diamond proxy

// ---------------------------------------------------------------
//  Uniswap V4 type stubs (minimal, for compilation without V4 dependency)
//  In production, import from @uniswap/v4-core
// ---------------------------------------------------------------

/// @dev Minimal PoolKey struct matching V4
struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

/// @dev Minimal swap params
struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

/// @dev Balance delta returned by V4
type BalanceDelta is int256;

/// @dev Minimal IPoolManager interface
interface IPoolManager {
    function swap(PoolKey calldata key, SwapParams calldata params, bytes calldata hookData)
        external returns (BalanceDelta);
}

/// @dev BeforeSwapDelta for V4 hooks -- the hook can modify the swap
type BeforeSwapDelta is int256;

contract AntiMEVHook is IAntiMEVHook {
    using AntiMEVStorage for AntiMEVStorage.State;

    // ---------------------------------------------------------------
    //  Events
    // ---------------------------------------------------------------
    event BotDetected(address indexed account, uint8 botScore, string reason);
    event SandwichDetected(address indexed attacker, address indexed victim, uint256 blockNumber);
    event TaxApplied(address indexed account, uint256 taxBps, uint256 taxAmount, string taxType);
    event ConfigUpdated(string param, uint256 oldValue, uint256 newValue);
    event DecoyTriggered(address indexed caller, string trap);

    // ---------------------------------------------------------------
    //  Errors
    // ---------------------------------------------------------------
    error NotOwner();
    error NotInitialized();
    error AlreadyInitialized();
    error InvalidBps();

    // ---------------------------------------------------------------
    //  Modifiers
    // ---------------------------------------------------------------
    modifier onlyOwner() {
        if (msg.sender != AntiMEVStorage.state().config.owner) revert NotOwner();
        _;
    }

    modifier whenInitialized() {
        if (!AntiMEVStorage.state().config.initialized) revert NotInitialized();
        _;
    }

    // ===============================================================
    //  INITIALIZATION
    // ===============================================================

    /// @notice Initialize the hook with default anti-MEV parameters
    /// @param _treasury Address that receives bot tax revenue
    /// @param _publicGoodFund Address for public good donations
    function initialize(address _treasury, address _publicGoodFund) external {
        AntiMEVStorage.State storage s = AntiMEVStorage.state();
        if (s.config.initialized) revert AlreadyInitialized();

        s.config = AntiMEVStorage.Config({
            baseTaxBps:             100,    // 1% normal tax
            botTaxBps:              8000,   // 80% bot tax
            sandwichTaxBps:         9500,   // 95% sandwich sell tax
            sniperTaxBps:           8000,   // 80% initial sniper tax
            sniperFloorBps:         500,    // 5% sniper tax floor
            sniperWindowBlocks:     50,     // ~100 seconds on Base (2s blocks)
            sameBuySellBlockPenalty: 80,     // +80 botScore
            gasThresholdGwei:       5,      // 5 gwei (Base usually <0.01)
            minHoldBlocks:          15,     // 30 seconds minimum hold
            poolInitBlock:          uint64(block.number),
            lastConfigUpdate:       uint64(block.timestamp),
            treasury:               _treasury,
            lpRewardPool:           _treasury, // default: same as treasury
            treasuryShareBps:       7000,   // 70% of bot tax -> treasury
            publicGoodBps:          10,     // 0.1% of bot tax -> public good
            publicGoodFund:         _publicGoodFund,
            owner:                  msg.sender,
            initialized:            true
        });

        // Set up the decoy honeypot
        s.decoyFeeRecipient = address(this); // "vulnerable" target
        s.realFeeRecipient = _treasury;      // where fees actually go
    }

    // ===============================================================
    //  V4 HOOK CALLBACKS
    // ===============================================================

    /// @notice Called by PoolManager before every swap
    /// @dev This is where we detect bot patterns and compute the dynamic fee.
    ///      Returns (bytes4 selector, BeforeSwapDelta, uint24 lpFeeOverride).
    ///      We use the lpFeeOverride to apply the punitive tax.
    function beforeSwap(
        address sender,
        PoolKey calldata /* key */,
        SwapParams calldata params,
        bytes calldata /* hookData */
    )
        external
        whenInitialized
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        AntiMEVStorage.State storage s = AntiMEVStorage.state();
        AntiMEVStorage.AddressProfile storage profile = s.profiles[sender];
        AntiMEVStorage.BlockState storage blk = s.blockStates[block.number];
        AntiMEVStorage.Config storage cfg = s.config;

        // --- First-time setup ---
        if (profile.firstSeenBlock == 0) {
            profile.firstSeenBlock = uint64(block.number);
        }

        // --- Determine direction ---
        // zeroForOne = true means selling token0 for token1 (context-dependent)
        // We treat the TOKEN as currency1 for Clanker convention (WETH/TOKEN).
        // zeroForOne = true => buying TOKEN (selling WETH)
        // zeroForOne = false => selling TOKEN (buying WETH)
        bool isBuy = params.zeroForOne;
        bool isSell = !params.zeroForOne;

        // --- Signal 1: Contract caller detection ---
        if (_isContract(sender)) {
            _addBotScore(profile, 40, "contract_caller");
        }

        // --- Signal 2: Gas price anomaly ---
        if (tx.gasprice > cfg.gasThresholdGwei * 1 gwei) {
            _addBotScore(profile, 30, "high_gas");
        }

        // --- Signal 3: Sniper detection (buying in the sniper window) ---
        if (isBuy && block.number < cfg.poolInitBlock + cfg.sniperWindowBlocks) {
            _addBotScore(profile, 60, "sniper_window");
        }

        // --- Signal 4: Same-block buy+sell ---
        if (isSell && profile.lastBuyBlock == uint64(block.number)) {
            _addBotScore(profile, uint8(cfg.sameBuySellBlockPenalty), "same_block_buy_sell");
        }
        if (isBuy && profile.lastSellBlock == uint64(block.number)) {
            _addBotScore(profile, uint8(cfg.sameBuySellBlockPenalty), "same_block_sell_buy");
        }

        // --- Signal 5: Sell too fast (within minHoldBlocks of last buy) ---
        if (isSell && profile.lastBuyBlock > 0) {
            uint64 holdBlocks = uint64(block.number) - profile.lastBuyBlock;
            if (holdBlocks > 0 && holdBlocks < uint64(cfg.minHoldBlocks)) {
                _addBotScore(profile, 20, "fast_sell");
            }
        }

        // --- Signal 6: Sandwich detection ---
        // A sandwich is: attacker buys, victim buys (price moves), attacker sells
        // We detect: if this is a sell AND in the same block as a buy from a
        //            DIFFERENT address AND the seller was the first buyer in block
        uint16 effectiveTax;
        string memory taxType;

        if (isSell && blk.firstBuyer == sender && blk.swapCountInBlock >= 2) {
            // This looks like the sell leg of a sandwich:
            // sender bought first in block, other swaps happened, now sender sells
            blk.sandwichFlagged = true;
            s.sandwichesDetected++;
            effectiveTax = cfg.sandwichTaxBps;
            taxType = "sandwich";
            emit SandwichDetected(sender, address(0), block.number);
        } else if (profile.botScore >= 128) {
            effectiveTax = cfg.botTaxBps;
            taxType = "bot";
        } else if (isBuy && block.number < cfg.poolInitBlock + cfg.sniperWindowBlocks) {
            // Sniper tax with linear decay
            uint64 elapsed = uint64(block.number) - cfg.poolInitBlock;
            uint16 decayRange = cfg.sniperTaxBps - cfg.sniperFloorBps;
            uint16 decayed = uint16(
                uint256(decayRange) * uint256(elapsed) / uint256(cfg.sniperWindowBlocks)
            );
            effectiveTax = cfg.sniperTaxBps - decayed;
            taxType = "sniper";
        } else {
            effectiveTax = cfg.baseTaxBps;
            taxType = "normal";
        }

        // --- Update block state ---
        blk.swapCountInBlock++;
        if (isBuy) {
            profile.lastBuyBlock = uint64(block.number);
            profile.buyCount++;
            if (blk.firstBuyer == address(0)) {
                blk.firstBuyer = sender;
                blk.firstBuyAmount = uint256(
                    params.amountSpecified > 0
                        ? params.amountSpecified
                        : -params.amountSpecified
                );
            }
        }
        if (isSell) {
            profile.lastSellBlock = uint64(block.number);
            profile.sellCount++;
        }

        // --- Return the override fee to V4 ---
        // V4 dynamic fee: return the fee in the lpFeeOverride slot
        // The fee is applied by the PoolManager as a swap fee
        // Encode: selector | BeforeSwapDelta(0) | lpFeeOverride
        return (
            this.beforeSwap.selector,
            BeforeSwapDelta.wrap(0),
            uint24(effectiveTax) | (1 << 23) // set override flag (bit 23)
        );
    }

    /// @notice Called by PoolManager after every swap completes
    /// @dev We use this to route tax revenue to the correct destinations
    function afterSwap(
        address sender,
        PoolKey calldata /* key */,
        SwapParams calldata /* params */,
        BalanceDelta delta,
        bytes calldata /* hookData */
    )
        external
        whenInitialized
        returns (bytes4, int128)
    {
        AntiMEVStorage.State storage s = AntiMEVStorage.state();
        AntiMEVStorage.AddressProfile storage profile = s.profiles[sender];

        // Determine what tax category this was in beforeSwap
        // We re-derive it from the profile state (cheaper than storing it cross-callback)
        uint16 taxBps = _currentTaxBps(sender);

        if (taxBps > s.config.baseTaxBps) {
            // This was a penalized swap -- record the tax revenue
            int256 rawDelta = BalanceDelta.unwrap(delta);
            uint256 swapSize = rawDelta > 0 ? uint256(rawDelta) : uint256(-rawDelta);
            uint256 taxAmount = (swapSize * uint256(taxBps)) / 10000;

            if (taxBps == s.config.sandwichTaxBps) {
                s.totalSandwichTaxCollected += taxAmount;
                emit TaxApplied(sender, taxBps, taxAmount, "sandwich");
            } else if (taxBps == s.config.botTaxBps) {
                s.totalBotTaxCollected += taxAmount;
                emit TaxApplied(sender, taxBps, taxAmount, "bot");
            } else if (taxBps >= s.config.sniperFloorBps) {
                s.totalSniperTaxCollected += taxAmount;
                emit TaxApplied(sender, taxBps, taxAmount, "sniper");
            }
        } else {
            // Normal tax
            int256 rawDelta2 = BalanceDelta.unwrap(delta);
            uint256 swapSize2 = rawDelta2 > 0 ? uint256(rawDelta2) : uint256(-rawDelta2);
            uint256 normalTax = (swapSize2 * uint256(taxBps)) / 10000;
            s.totalRegularTaxCollected += normalTax;
        }

        return (this.afterSwap.selector, 0);
    }

    // ===============================================================
    //  DECOY / HONEYPOT FUNCTIONS
    // ===============================================================

    /// @notice DECOY: This function LOOKS like it sets the fee recipient
    ///         with weak access control.  Bots scanning for "setFeeRecipient"
    ///         with no timelock will try to frontrun calls to this.
    ///         But it only sets the DECOY recipient -- real fees flow elsewhere.
    /// @dev The function signature matches common fee-recipient setters that
    ///      MEV bots search for.  The access control is intentionally loose-
    ///      looking (only checks msg.value > 0) to bait bot interaction.
    function setFeeRecipient(address _newRecipient) external payable {
        // Intentionally weak-looking guard: just requires some ETH
        // Bots will send the minimum to pass this check
        require(msg.value > 0, "Must send ETH");

        AntiMEVStorage.State storage s = AntiMEVStorage.state();

        // TRAP: We take their ETH and set the DECOY recipient
        // The real fee flow goes through realFeeRecipient, not decoyFeeRecipient
        s.decoyFeeRecipient = _newRecipient;

        // Forward the bait ETH to the real treasury
        (bool ok,) = s.realFeeRecipient.call{value: msg.value}("");
        require(ok, "transfer failed");

        emit DecoyTriggered(msg.sender, "setFeeRecipient_honeypot");
    }

    /// @notice DECOY: Looks like a withdraw function with a reentrancy bug.
    ///         Bots looking for reentrancy will try to exploit this.
    ///         But the "balance" it reads is always 0 in practice because
    ///         real funds are never stored at the decoy mapping.
    function withdrawFees() external {
        AntiMEVStorage.State storage s = AntiMEVStorage.state();

        // This reads from decoyFeeRecipient's perspective -- always 0
        // Bots waste gas calling this
        uint256 balance = address(this).balance;

        // Even if there is dust, it goes to the real treasury
        if (balance > 0) {
            (bool ok,) = s.realFeeRecipient.call{value: balance}("");
            require(ok, "transfer failed");
        }

        emit DecoyTriggered(msg.sender, "withdrawFees_honeypot");
    }

    /// @notice DECOY: A "vulnerable" approve function that bots might try to
    ///         use to drain token approvals.  Does nothing useful.
    function emergencyWithdraw(address token, uint256 amount) external {
        // Looks exploitable -- no access control!
        // But it just emits an event and marks the caller as a bot
        AntiMEVStorage.State storage s = AntiMEVStorage.state();
        AntiMEVStorage.AddressProfile storage profile = s.profiles[msg.sender];

        _addBotScore(profile, 100, "honeypot_emergencyWithdraw");
        s.botsDetected++;

        emit DecoyTriggered(msg.sender, "emergencyWithdraw_honeypot");
        // Does NOT actually transfer anything
    }

    // ===============================================================
    //  V4 HOOK FLAG FUNCTIONS
    // ===============================================================

    /// @notice Returns the hook permission flags for V4 PoolManager registration
    /// @dev Encodes which callbacks this hook implements.
    ///      We need: beforeSwap (detection), afterSwap (revenue routing),
    ///               beforeInitialize (set poolInitBlock)
    function getHookPermissions() external pure returns (
        bool beforeInitialize,
        bool afterInitialize,
        bool beforeAddLiquidity,
        bool afterAddLiquidity,
        bool beforeRemoveLiquidity,
        bool afterRemoveLiquidity,
        bool beforeSwap_,
        bool afterSwap_,
        bool beforeDonate,
        bool afterDonate
    ) {
        return (
            true,   // beforeInitialize -- record pool init block
            false,  // afterInitialize
            false,  // beforeAddLiquidity
            false,  // afterAddLiquidity
            false,  // beforeRemoveLiquidity
            false,  // afterRemoveLiquidity
            true,   // beforeSwap -- bot detection + dynamic fee
            true,   // afterSwap -- revenue routing
            false,  // beforeDonate
            false   // afterDonate
        );
    }

    /// @notice Called when the pool is first initialized
    /// @dev Records the pool initialization block for sniper tax decay
    function beforeInitialize(
        address /* sender */,
        PoolKey calldata /* key */,
        uint160 /* sqrtPriceX96 */,
        bytes calldata /* hookData */
    ) external returns (bytes4) {
        AntiMEVStorage.State storage s = AntiMEVStorage.state();
        s.config.poolInitBlock = uint64(block.number);
        return this.beforeInitialize.selector;
    }

    // ===============================================================
    //  VIEW FUNCTIONS
    // ===============================================================

    /// @inheritdoc IAntiMEVHook
    function getEffectiveTaxBps(address account) external view override returns (uint16) {
        return _currentTaxBps(account);
    }

    /// @inheritdoc IAntiMEVHook
    function isBotClassified(address account) external view override returns (bool) {
        return AntiMEVStorage.state().profiles[account].botScore >= 128;
    }

    /// @inheritdoc IAntiMEVHook
    function getStats() external view override returns (
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

    /// @notice Get the full profile for an address
    function getProfile(address account) external view returns (
        uint64 firstSeenBlock,
        uint64 lastBuyBlock,
        uint64 lastSellBlock,
        uint32 buyCount,
        uint32 sellCount,
        uint8 botScore,
        bool whitelisted
    ) {
        AntiMEVStorage.AddressProfile storage p = AntiMEVStorage.state().profiles[account];
        return (
            p.firstSeenBlock,
            p.lastBuyBlock,
            p.lastSellBlock,
            p.buyCount,
            p.sellCount,
            p.botScore,
            p.whitelisted
        );
    }

    /// @notice Get block-level state for sandwich detection diagnostics
    function getBlockState(uint256 blockNumber) external view returns (
        address firstBuyer,
        uint256 firstBuyAmount,
        uint128 swapCountInBlock,
        bool sandwichFlagged
    ) {
        AntiMEVStorage.BlockState storage b = AntiMEVStorage.state().blockStates[blockNumber];
        return (b.firstBuyer, b.firstBuyAmount, b.swapCountInBlock, b.sandwichFlagged);
    }

    // ===============================================================
    //  ADMIN FUNCTIONS
    // ===============================================================

    function setBaseTaxBps(uint16 _bps) external onlyOwner {
        if (_bps > 1000) revert InvalidBps(); // max 10%
        AntiMEVStorage.Config storage cfg = AntiMEVStorage.state().config;
        emit ConfigUpdated("baseTaxBps", cfg.baseTaxBps, _bps);
        cfg.baseTaxBps = _bps;
    }

    function setBotTaxBps(uint16 _bps) external onlyOwner {
        if (_bps > 9900) revert InvalidBps();
        AntiMEVStorage.Config storage cfg = AntiMEVStorage.state().config;
        emit ConfigUpdated("botTaxBps", cfg.botTaxBps, _bps);
        cfg.botTaxBps = _bps;
    }

    function setSandwichTaxBps(uint16 _bps) external onlyOwner {
        if (_bps > 9900) revert InvalidBps();
        AntiMEVStorage.Config storage cfg = AntiMEVStorage.state().config;
        emit ConfigUpdated("sandwichTaxBps", cfg.sandwichTaxBps, _bps);
        cfg.sandwichTaxBps = _bps;
    }

    function setGasThreshold(uint256 _gwei) external onlyOwner {
        AntiMEVStorage.Config storage cfg = AntiMEVStorage.state().config;
        emit ConfigUpdated("gasThresholdGwei", cfg.gasThresholdGwei, _gwei);
        cfg.gasThresholdGwei = _gwei;
    }

    function setMinHoldBlocks(uint256 _blocks) external onlyOwner {
        AntiMEVStorage.Config storage cfg = AntiMEVStorage.state().config;
        emit ConfigUpdated("minHoldBlocks", cfg.minHoldBlocks, _blocks);
        cfg.minHoldBlocks = _blocks;
    }

    function whitelistAddress(address _account, bool _status) external onlyOwner {
        AntiMEVStorage.state().profiles[_account].whitelisted = _status;
    }

    function setTreasury(address _treasury) external onlyOwner {
        AntiMEVStorage.Config storage cfg = AntiMEVStorage.state().config;
        cfg.treasury = _treasury;
    }

    function setLpRewardPool(address _pool) external onlyOwner {
        AntiMEVStorage.Config storage cfg = AntiMEVStorage.state().config;
        cfg.lpRewardPool = _pool;
    }

    // ===============================================================
    //  INTERNAL FUNCTIONS
    // ===============================================================

    /// @dev Compute the current effective tax for an address
    function _currentTaxBps(address account) internal view returns (uint16) {
        AntiMEVStorage.State storage s = AntiMEVStorage.state();
        AntiMEVStorage.AddressProfile storage p = s.profiles[account];
        AntiMEVStorage.Config storage cfg = s.config;

        if (p.whitelisted) return 0;

        // Check sandwich (current block)
        AntiMEVStorage.BlockState storage blk = s.blockStates[block.number];
        if (blk.firstBuyer == account && blk.swapCountInBlock >= 2) {
            return cfg.sandwichTaxBps;
        }

        if (p.botScore >= 128) return cfg.botTaxBps;

        // Sniper window
        if (block.number < cfg.poolInitBlock + cfg.sniperWindowBlocks) {
            uint64 elapsed = uint64(block.number) - cfg.poolInitBlock;
            uint16 decayRange = cfg.sniperTaxBps - cfg.sniperFloorBps;
            uint16 decayed = uint16(
                uint256(decayRange) * uint256(elapsed) / uint256(cfg.sniperWindowBlocks)
            );
            return cfg.sniperTaxBps - decayed;
        }

        return cfg.baseTaxBps;
    }

    /// @dev Add to an address's bot score (capped at 255)
    function _addBotScore(
        AntiMEVStorage.AddressProfile storage profile,
        uint8 points,
        string memory reason
    ) internal {
        uint16 newScore = uint16(profile.botScore) + uint16(points);
        if (newScore > 255) newScore = 255;

        bool wasBelowThreshold = profile.botScore < 128;
        profile.botScore = uint8(newScore);

        if (wasBelowThreshold && newScore >= 128) {
            AntiMEVStorage.state().botsDetected++;
            // Note: we can't emit with msg.sender here because sender
            // is the PoolManager in V4 context.  The 'sender' param
            // from beforeSwap is the actual initiator.
            emit BotDetected(address(0), uint8(newScore), reason);
        }
    }

    /// @dev Check if an address is a contract
    function _isContract(address account) internal view returns (bool) {
        uint256 size;
        assembly {
            size := extcodesize(account)
        }
        // NOTE: This can be bypassed by calling from a constructor.
        // That is why it is only ONE signal among many, not the sole detector.
        // EIP-7702 delegated EOAs will also show extcodesize > 0,
        // so we give it moderate weight (40) not conclusive weight.
        return size > 0;
    }

    /// @dev Receive ETH (from honeypot interactions)
    receive() external payable {}
}
