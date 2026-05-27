// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {DiamondStorage} from "./DiamondStorage.sol";

contract Diamond {
    struct FacetInit {
        address facetAddress;
        bytes4[] selectors;
    }

    constructor(address _owner, FacetInit[] memory _facets) {
        DiamondStorage.DiamondState storage ds = DiamondStorage.diamondStorage();
        ds.contractOwner = _owner;
        ds.feeRecipient = _owner;
        ds.message = "Diamond initialized - break me if you can";

        for (uint256 i = 0; i < _facets.length; i++) {
            address facet = _facets[i].facetAddress;
            bytes4[] memory sels = _facets[i].selectors;
            for (uint256 j = 0; j < sels.length; j++) {
                ds.facetAddressAndSelectorPosition[sels[j]] = DiamondStorage.FacetAddressAndSelectorPosition({
                    facetAddress: facet,
                    selectorPosition: uint16(ds.selectors.length)
                });
                ds.selectors.push(sels[j]);
            }
        }
    }

    fallback() external payable {
        DiamondStorage.DiamondState storage ds = DiamondStorage.diamondStorage();
        address facet = ds.facetAddressAndSelectorPosition[msg.sig].facetAddress;
        require(facet != address(0), "Diamond: function does not exist");

        assembly {
            calldatacopy(0, 0, calldatasize())
            let result := delegatecall(gas(), facet, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch result
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }

    receive() external payable {
        DiamondStorage.DiamondState storage ds = DiamondStorage.diamondStorage();
        ds.treasuryBalance += msg.value;
    }
}
