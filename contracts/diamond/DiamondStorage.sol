// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

library DiamondStorage {
    bytes32 constant DIAMOND_STORAGE_POSITION = keccak256("spoofwallet.diamond.storage");

    struct FacetAddressAndSelectorPosition {
        address facetAddress;
        uint16 selectorPosition;
    }

    struct DiamondState {
        mapping(bytes4 => FacetAddressAndSelectorPosition) facetAddressAndSelectorPosition;
        bytes4[] selectors;
        mapping(bytes4 => bool) supportedInterfaces;
        address contractOwner;
        address feeRecipient;
        string message;
        uint256 publicCallCount;
        uint256 ownerCallCount;
        bool spoofSucceeded;
        mapping(address => bool) approvedOperators;
        uint256 treasuryBalance;
        address pendingOwner;
    }

    function diamondStorage() internal pure returns (DiamondState storage ds) {
        bytes32 position = DIAMOND_STORAGE_POSITION;
        assembly {
            ds.slot := position
        }
    }
}
