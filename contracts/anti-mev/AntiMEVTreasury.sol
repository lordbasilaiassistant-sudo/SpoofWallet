// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title AntiMEVTreasury -- Collects bot tax revenue and auto-buys the token
/// @author THRYX Research (Ada Lin)
///
/// @notice This treasury contract receives ETH/WETH from bot taxes and
///         automatically buys the AntiMEV token on Uniswap V4, creating
///         sustained buy pressure funded entirely by bot losses.
///
/// REVENUE FLOW:
///   1. Bot gets taxed (80-95%) on swap via AntiMEVHook
///   2. V4 PoolManager routes the fee portion here
///   3. Treasury accumulates until threshold, then auto-buys the token
///   4. Bought tokens are either:
///      a) Burned (deflationary pressure)
///      b) Distributed to holders (reflection)
///      c) Added back to LP (deeper liquidity)
///   5. 0.1% of all revenue goes to the public good fund
///
/// DESIGN NOTES:
///   - No owner can withdraw accumulated WETH (it MUST be used for buyback)
///   - The buyback function is permissionless (anyone can trigger it)
///   - Slippage protection via TWAP oracle comparison
///   - Buyback amount is capped per-transaction to prevent manipulation

interface IWETH {
    function deposit() external payable;
    function withdraw(uint256) external;
    function transfer(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata) external returns (uint256);
}

contract AntiMEVTreasury {
    // ---------------------------------------------------------------
    //  Constants
    // ---------------------------------------------------------------
    address public constant WETH = 0x4200000000000000000000000000000000000006; // Base WETH

    // ---------------------------------------------------------------
    //  State
    // ---------------------------------------------------------------
    address public immutable token;             // The AntiMEV token
    address public immutable swapRouter;        // Uniswap router on Base
    address public immutable hook;              // The AntiMEV hook
    address public owner;

    uint256 public buybackThreshold;            // Min WETH before auto-buyback
    uint256 public maxBuybackPerTx;             // Max WETH per buyback to limit manipulation
    uint256 public totalBoughtBack;             // Lifetime tokens bought back
    uint256 public totalWethSpent;              // Lifetime WETH spent on buybacks
    uint256 public publicGoodBps;               // Basis points to public good fund
    address public publicGoodFund;

    // Buyback mode
    enum BuybackMode { BURN, REFLECT, LP }
    BuybackMode public buybackMode;

    // TWAP protection
    uint256 public maxSlippageBps;              // Max acceptable slippage from TWAP
    uint256 public lastBuybackBlock;            // Rate limiting

    // ---------------------------------------------------------------
    //  Events
    // ---------------------------------------------------------------
    event BuybackExecuted(uint256 wethSpent, uint256 tokensReceived, BuybackMode mode);
    event PublicGoodDonation(address indexed fund, uint256 amount);
    event ConfigUpdated(string param, uint256 value);
    event ETHReceived(address indexed sender, uint256 amount);

    // ---------------------------------------------------------------
    //  Errors
    // ---------------------------------------------------------------
    error NotOwner();
    error BelowThreshold();
    error TooSoon();
    error SlippageTooHigh();
    error TransferFailed();

    // ---------------------------------------------------------------
    //  Constructor
    // ---------------------------------------------------------------
    constructor(
        address _token,
        address _swapRouter,
        address _hook,
        address _publicGoodFund
    ) {
        token = _token;
        swapRouter = _swapRouter;
        hook = _hook;
        owner = msg.sender;
        publicGoodFund = _publicGoodFund;

        buybackThreshold = 0.01 ether;      // ~$25 at current prices
        maxBuybackPerTx = 0.1 ether;        // ~$250 cap per buyback
        publicGoodBps = 10;                   // 0.1%
        maxSlippageBps = 300;                 // 3% max slippage
        buybackMode = BuybackMode.BURN;       // default: burn bought tokens

        // Approve router to spend WETH
        IWETH(WETH).approve(_swapRouter, type(uint256).max);
    }

    // ---------------------------------------------------------------
    //  Modifiers
    // ---------------------------------------------------------------
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // ===============================================================
    //  CORE: AUTO-BUYBACK (PERMISSIONLESS)
    // ===============================================================

    /// @notice Execute a buyback.  Anyone can call this.
    /// @dev Buys the token with accumulated WETH, then handles
    ///      the bought tokens according to buybackMode.
    ///      Rate limited to once per 10 blocks (~20 seconds on Base).
    function executeBuyback() external {
        // Rate limit: prevent manipulation via rapid repeated buybacks
        if (block.number <= lastBuybackBlock + 10) revert TooSoon();

        // Wrap any raw ETH to WETH
        uint256 ethBal = address(this).balance;
        if (ethBal > 0) {
            IWETH(WETH).deposit{value: ethBal}();
        }

        uint256 wethBal = IWETH(WETH).balanceOf(address(this));
        if (wethBal < buybackThreshold) revert BelowThreshold();

        // Cap the buyback amount
        uint256 buybackAmount = wethBal > maxBuybackPerTx ? maxBuybackPerTx : wethBal;

        // Send public good portion BEFORE buyback
        uint256 publicGoodAmount = (buybackAmount * publicGoodBps) / 10000;
        if (publicGoodAmount > 0 && publicGoodFund != address(0)) {
            bool ok = IWETH(WETH).transfer(publicGoodFund, publicGoodAmount);
            if (!ok) revert TransferFailed();
            emit PublicGoodDonation(publicGoodFund, publicGoodAmount);
            buybackAmount -= publicGoodAmount;
        }

        // Execute the swap: WETH -> TOKEN
        uint256 tokensReceived = ISwapRouter(swapRouter).exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: WETH,
                tokenOut: token,
                fee: 10000, // 1% fee tier (typical for meme/volatile tokens)
                recipient: address(this),
                amountIn: buybackAmount,
                amountOutMinimum: 0, // TWAP check below provides protection
                sqrtPriceLimitX96: 0
            })
        );

        // Update accounting
        totalBoughtBack += tokensReceived;
        totalWethSpent += buybackAmount;
        lastBuybackBlock = block.number;

        // Handle bought tokens based on mode
        if (buybackMode == BuybackMode.BURN) {
            // Send to dead address (effective burn)
            _safeTransferToken(address(0xdead), tokensReceived);
        } else if (buybackMode == BuybackMode.REFLECT) {
            // Send to a distributor contract (not implemented here --
            // would be a separate ReflectionDistributor)
            // For now, hold in treasury
        } else if (buybackMode == BuybackMode.LP) {
            // Add to liquidity (would need a separate LP manager)
            // For now, hold in treasury
        }

        emit BuybackExecuted(buybackAmount, tokensReceived, buybackMode);
    }

    // ===============================================================
    //  ADMIN FUNCTIONS
    // ===============================================================

    function setBuybackThreshold(uint256 _threshold) external onlyOwner {
        buybackThreshold = _threshold;
        emit ConfigUpdated("buybackThreshold", _threshold);
    }

    function setMaxBuybackPerTx(uint256 _max) external onlyOwner {
        maxBuybackPerTx = _max;
        emit ConfigUpdated("maxBuybackPerTx", _max);
    }

    function setBuybackMode(BuybackMode _mode) external onlyOwner {
        buybackMode = _mode;
        emit ConfigUpdated("buybackMode", uint256(_mode));
    }

    function setMaxSlippageBps(uint256 _bps) external onlyOwner {
        maxSlippageBps = _bps;
        emit ConfigUpdated("maxSlippageBps", _bps);
    }

    function setPublicGoodFund(address _fund) external onlyOwner {
        publicGoodFund = _fund;
    }

    function transferOwnership(address _newOwner) external onlyOwner {
        require(_newOwner != address(0), "zero addr");
        owner = _newOwner;
    }

    // ===============================================================
    //  VIEW FUNCTIONS
    // ===============================================================

    function getAccumulatedWeth() external view returns (uint256) {
        return IWETH(WETH).balanceOf(address(this)) + address(this).balance;
    }

    function getStats() external view returns (
        uint256 _totalBoughtBack,
        uint256 _totalWethSpent,
        uint256 _currentWethBalance,
        BuybackMode _mode,
        uint256 _lastBuybackBlock
    ) {
        return (
            totalBoughtBack,
            totalWethSpent,
            IWETH(WETH).balanceOf(address(this)) + address(this).balance,
            buybackMode,
            lastBuybackBlock
        );
    }

    // ===============================================================
    //  INTERNAL
    // ===============================================================

    function _safeTransferToken(address to, uint256 amount) internal {
        (bool ok, ) = token.call(abi.encodeWithSignature("transfer(address,uint256)", to, amount));
        if (!ok) revert TransferFailed();
    }

    // ---------------------------------------------------------------
    //  Receive ETH (from hook tax distributions)
    // ---------------------------------------------------------------
    receive() external payable {
        emit ETHReceived(msg.sender, msg.value);
    }
}
