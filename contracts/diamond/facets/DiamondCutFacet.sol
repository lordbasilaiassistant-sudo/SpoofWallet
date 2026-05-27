// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {DiamondStorage} from "../DiamondStorage.sol";

contract DiamondCutFacet {
    event DiamondCut(address indexed facetAddress, bytes4[] selectors, uint8 action);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    enum FacetCutAction { Add, Replace, Remove }

    modifier onlyOwner() {
        DiamondStorage.DiamondState storage ds = DiamondStorage.diamondStorage();
        require(msg.sender == ds.contractOwner, "DiamondCut: not owner");
        _;
    }

    function diamondCut(
        address _facetAddress,
        bytes4[] calldata _selectors,
        FacetCutAction _action
    ) external onlyOwner {
        DiamondStorage.DiamondState storage ds = DiamondStorage.diamondStorage();

        if (_action == FacetCutAction.Add) {
            for (uint256 i = 0; i < _selectors.length; i++) {
                require(
                    ds.facetAddressAndSelectorPosition[_selectors[i]].facetAddress == address(0),
                    "DiamondCut: selector already added"
                );
                ds.facetAddressAndSelectorPosition[_selectors[i]] = DiamondStorage.FacetAddressAndSelectorPosition({
                    facetAddress: _facetAddress,
                    selectorPosition: uint16(ds.selectors.length)
                });
                ds.selectors.push(_selectors[i]);
            }
        } else if (_action == FacetCutAction.Replace) {
            for (uint256 i = 0; i < _selectors.length; i++) {
                require(
                    ds.facetAddressAndSelectorPosition[_selectors[i]].facetAddress != address(0),
                    "DiamondCut: selector not found"
                );
                ds.facetAddressAndSelectorPosition[_selectors[i]].facetAddress = _facetAddress;
            }
        } else if (_action == FacetCutAction.Remove) {
            for (uint256 i = 0; i < _selectors.length; i++) {
                require(
                    ds.facetAddressAndSelectorPosition[_selectors[i]].facetAddress != address(0),
                    "DiamondCut: selector not found"
                );
                uint16 selectorPosition = ds.facetAddressAndSelectorPosition[_selectors[i]].selectorPosition;
                uint256 lastIndex = ds.selectors.length - 1;
                if (selectorPosition != lastIndex) {
                    bytes4 lastSelector = ds.selectors[lastIndex];
                    ds.selectors[selectorPosition] = lastSelector;
                    ds.facetAddressAndSelectorPosition[lastSelector].selectorPosition = selectorPosition;
                }
                ds.selectors.pop();
                delete ds.facetAddressAndSelectorPosition[_selectors[i]];
            }
        }

        ds.ownerCallCount++;
        emit DiamondCut(_facetAddress, _selectors, uint8(_action));
    }

    function transferOwnership(address _newOwner) external onlyOwner {
        require(_newOwner != address(0), "DiamondCut: zero address");
        DiamondStorage.DiamondState storage ds = DiamondStorage.diamondStorage();
        address previous = ds.contractOwner;
        ds.contractOwner = _newOwner;
        emit OwnershipTransferred(previous, _newOwner);
    }

    function owner() external view returns (address) {
        return DiamondStorage.diamondStorage().contractOwner;
    }
}
