// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import "../test/Sandwich.t.sol";

contract SeedBuyScript is Script {
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant LOCKER = 0x63D2DfEA64b3433F4071A98665bcD7Ca14d93496;
    address constant HOOK = 0xb429d62f8f3bFFb98CdB9569533eA23bF0Ba28CC;

    function run() external {
        uint256 pk = vm.envUint("THRYXTREASURY_PRIVATE_KEY");
        vm.startBroadcast(pk);

        // Deploy the attacker contract
        SandwichAttacker attacker = new SandwichAttacker();

        // Send it some WETH for the swap
        IERC20(WETH).transfer(address(attacker), 0.0001 ether);

        // Buy token (YPLT - our MCP token)
        address token = 0x73F537DF092964005d03F7345787daD4A2B54E37;
        PoolKey memory key = PoolKey({
            currency0: token < WETH ? token : WETH,
            currency1: token < WETH ? WETH : token,
            fee: 0x800000,
            tickSpacing: int24(200),
            hooks: HOOK
        });

        attacker.attack(token, LOCKER, 0.00005 ether, key);

        vm.stopBroadcast();

        console.log("Seed buy complete on YPLT");
        console.log("Attacker:", address(attacker));
    }
}
