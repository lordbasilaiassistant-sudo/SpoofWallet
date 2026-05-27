// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import "../test/Sandwich.t.sol";

contract SeedAllScript is Script {
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant LOCKER = 0x63D2DfEA64b3433F4071A98665bcD7Ca14d93496;
    address constant HOOK_DYNAMIC = 0xb429d62f8f3bFFb98CdB9569533eA23bF0Ba28CC;
    address constant HOOK_STATIC = 0xd60D6B218116cFd801E28F78d011a203D2b068Cc;

    function run() external {
        uint256 pk = vm.envUint("THRYXTREASURY_PRIVATE_KEY");
        vm.startBroadcast(pk);

        SandwichAttacker attacker = new SandwichAttacker();
        IERC20(WETH).transfer(address(attacker), 0.001 ether);

        // WETH-paired tokens (dynamic hook)
        address[10] memory wethTokens = [
            0xE340207FDd4D6067340C81EAE958687dB8583c8A,  // EID
            0xc73484AFaCe2c2bc58df027864F1736801A7a75B,  // BASEDAI
            0xD7B3c1672f49e050B4b83D09ACBb174E9f95794f,  // PEACE
            0xD45FE8A42E66B6e5C9b396D05A687F0BDBB20540,  // CAVS
            0x59eCC2f83Cc4174F2cb08034E639611303147733,  // TRUMP26
            0x1486aa5898c5692a43A85547DD41598159E36fF9,  // WEMBY
            0xa95d1FE26D3886d3fF2E0D7905FEAcD70F9a5098,  // GUNNER
            0x3482A76eB9302dC01eb8E45Fcb72552a8878fd9F,  // DROP
            0x106c60F8368d47a137e244C7409BC1037E6aEeeB,  // ARMY
            0xAE8eabc8919308A39Cf607eFa7129e9B0422FB07   // NXVLT B07
        ];

        for (uint256 i = 0; i < wethTokens.length; i++) {
            address token = wethTokens[i];
            PoolKey memory key = PoolKey({
                currency0: token < WETH ? token : WETH,
                currency1: token < WETH ? WETH : token,
                fee: 0x800000,
                tickSpacing: int24(200),
                hooks: HOOK_DYNAMIC
            });

            try attacker.attack(token, LOCKER, 0.00005 ether, key) {
                console.log("Seeded:", i);
            } catch {
                console.log("Failed:", i);
            }
        }

        // Rescue remaining WETH
        attacker.rescue(WETH);

        vm.stopBroadcast();
        console.log("Seed complete");
    }
}
