// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IAntiMEVHook -- interface for the anti-MEV V4 hook
/// @notice Minimal interface so the token and treasury can call back into the hook.
interface IAntiMEVHook {
    /// @notice Returns the effective tax rate in bps for a given address at this moment
    function getEffectiveTaxBps(address account) external view returns (uint16);

    /// @notice Returns whether an address is classified as a bot
    function isBotClassified(address account) external view returns (bool);

    /// @notice Returns cumulative stats
    function getStats() external view returns (
        uint256 totalBotTax,
        uint256 totalSandwichTax,
        uint256 totalSniperTax,
        uint256 totalRegularTax,
        uint256 botsDetected,
        uint256 sandwichesDetected
    );
}
