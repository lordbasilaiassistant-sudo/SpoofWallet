// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {DiamondStorage} from "../DiamondStorage.sol";

contract DiamondCutFacetV2 {
    event DiamondCut(address indexed facetAddress, bytes4[] selectors, uint8 action);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);

    enum FacetCutAction { Add, Replace, Remove }

    bytes4 constant DIAMOND_CUT_SELECTOR = 0x204dbd34;
    bytes4 constant TRANSFER_OWNERSHIP_SELECTOR = 0xf2fde38b;
    bytes4 constant ACCEPT_OWNERSHIP_SELECTOR = 0x79ba5097;
    bytes4 constant OWNER_SELECTOR = 0x8da5cb5b;

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

        // FIX F-01: Validate facet has code for Add/Replace
        if (_action == FacetCutAction.Add || _action == FacetCutAction.Replace) {
            require(_facetAddress != address(0), "DiamondCut: zero address facet");
            uint256 codeSize;
            assembly { codeSize := extcodesize(_facetAddress) }
            require(codeSize > 0, "DiamondCut: facet has no code");
        }

        if (_action == FacetCutAction.Add) {
            require(ds.selectors.length + _selectors.length <= type(uint16).max, "DiamondCut: too many selectors");
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
                // FIX F-02: Protect critical selectors from replacement
                _requireNotCritical(_selectors[i]);
                ds.facetAddressAndSelectorPosition[_selectors[i]].facetAddress = _facetAddress;
            }
        } else if (_action == FacetCutAction.Remove) {
            for (uint256 i = 0; i < _selectors.length; i++) {
                require(
                    ds.facetAddressAndSelectorPosition[_selectors[i]].facetAddress != address(0),
                    "DiamondCut: selector not found"
                );
                // FIX F-02: Protect critical selectors from removal
                _requireNotCritical(_selectors[i]);
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

    // FIX F-03: Two-step ownership transfer
    function transferOwnership(address _newOwner) external onlyOwner {
        require(_newOwner != address(0), "DiamondCut: zero address");
        DiamondStorage.DiamondState storage ds = DiamondStorage.diamondStorage();
        ds.pendingOwner = _newOwner;
        emit OwnershipTransferStarted(ds.contractOwner, _newOwner);
    }

    function acceptOwnership() external {
        DiamondStorage.DiamondState storage ds = DiamondStorage.diamondStorage();
        require(msg.sender == ds.pendingOwner, "DiamondCut: not pending owner");
        address previous = ds.contractOwner;
        ds.contractOwner = msg.sender;
        ds.pendingOwner = address(0);
        emit OwnershipTransferred(previous, msg.sender);
    }

    function pendingOwner() external view returns (address) {
        return DiamondStorage.diamondStorage().pendingOwner;
    }

    function owner() external view returns (address) {
        return DiamondStorage.diamondStorage().contractOwner;
    }

    function _requireNotCritical(bytes4 selector) internal pure {
        require(
            selector != DIAMOND_CUT_SELECTOR &&
            selector != TRANSFER_OWNERSHIP_SELECTOR &&
            selector != ACCEPT_OWNERSHIP_SELECTOR &&
            selector != OWNER_SELECTOR,
            "DiamondCut: cannot modify core selector"
        );
    }
}
