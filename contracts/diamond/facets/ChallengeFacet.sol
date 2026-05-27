// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {DiamondStorage} from "../DiamondStorage.sol";

contract ChallengeFacet {
    event PublicCalled(address indexed caller, uint256 count);
    event OwnerActionSuccess(address indexed caller, string action);
    event FeeRecipientChanged(address indexed oldRecip, address indexed newRecip, address indexed changedBy);
    event SpoofClaimed(address indexed claimer, bool success);
    event OperatorApproved(address indexed operator, bool approved);
    event TreasuryWithdrawal(address indexed to, uint256 amount);

    modifier onlyOwner() {
        DiamondStorage.DiamondState storage ds = DiamondStorage.diamondStorage();
        require(msg.sender == ds.contractOwner, "Challenge: not owner");
        _;
    }

    modifier onlyOwnerOrOperator() {
        DiamondStorage.DiamondState storage ds = DiamondStorage.diamondStorage();
        require(
            msg.sender == ds.contractOwner || ds.approvedOperators[msg.sender],
            "Challenge: not owner or operator"
        );
        _;
    }

    function callPublic() external {
        DiamondStorage.DiamondState storage ds = DiamondStorage.diamondStorage();
        ds.publicCallCount++;
        emit PublicCalled(msg.sender, ds.publicCallCount);
    }

    function setMessage(string calldata newMessage) external onlyOwner {
        DiamondStorage.DiamondState storage ds = DiamondStorage.diamondStorage();
        ds.ownerCallCount++;
        ds.message = newMessage;
        emit OwnerActionSuccess(msg.sender, "setMessage");
    }

    function setFeeRecipient(address newRecipient) external onlyOwner {
        require(newRecipient != address(0), "Zero address");
        DiamondStorage.DiamondState storage ds = DiamondStorage.diamondStorage();
        address old = ds.feeRecipient;
        ds.feeRecipient = newRecipient;
        ds.ownerCallCount++;
        emit FeeRecipientChanged(old, newRecipient, msg.sender);
        emit OwnerActionSuccess(msg.sender, "setFeeRecipient");
    }

    function claimSpoof() external onlyOwner {
        DiamondStorage.DiamondState storage ds = DiamondStorage.diamondStorage();
        ds.spoofSucceeded = true;
        emit SpoofClaimed(msg.sender, true);
    }

    function approveOperator(address operator, bool approved) external onlyOwner {
        DiamondStorage.DiamondState storage ds = DiamondStorage.diamondStorage();
        ds.approvedOperators[operator] = approved;
        emit OperatorApproved(operator, approved);
    }

    function withdrawTreasury(address to, uint256 amount) external onlyOwnerOrOperator {
        require(to != address(0), "Zero address");
        DiamondStorage.DiamondState storage ds = DiamondStorage.diamondStorage();
        require(amount <= ds.treasuryBalance, "Insufficient balance");
        ds.treasuryBalance -= amount;
        (bool ok,) = payable(to).call{value: amount}("");
        require(ok, "Transfer failed");
        emit TreasuryWithdrawal(to, amount);
    }

    function getState() external view returns (
        address _owner,
        address _feeRecipient,
        string memory _message,
        uint256 _publicCalls,
        uint256 _ownerCalls,
        bool _spoofSucceeded,
        uint256 _treasuryBalance
    ) {
        DiamondStorage.DiamondState storage ds = DiamondStorage.diamondStorage();
        return (
            ds.contractOwner,
            ds.feeRecipient,
            ds.message,
            ds.publicCallCount,
            ds.ownerCallCount,
            ds.spoofSucceeded,
            ds.treasuryBalance
        );
    }

    function isOperator(address addr) external view returns (bool) {
        return DiamondStorage.diamondStorage().approvedOperators[addr];
    }
}
