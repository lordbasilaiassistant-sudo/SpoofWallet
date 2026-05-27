// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract SpoofChallenge {
    address public owner;
    address public feeRecipient;
    string public message;
    uint256 public publicCallCount;
    uint256 public ownerCallCount;
    bool public spoofSucceeded;

    event PublicCalled(address indexed caller, uint256 count);
    event OwnerActionSuccess(address indexed caller, string action);
    event OwnerActionReverted(address indexed caller, string action);
    event FeeRecipientChanged(address indexed oldRecip, address indexed newRecip, address indexed changedBy);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);
    event SpoofClaimed(address indexed claimer, bool success);
    event SpoofDetected(address indexed claimer, address indexed realSender);

    constructor() {
        owner = msg.sender;
        feeRecipient = msg.sender;
        message = "Only the real owner can change this";
    }

    function callPublic() external {
        publicCallCount++;
        emit PublicCalled(msg.sender, publicCallCount);
    }

    function setMessage(string calldata newMessage) external {
        require(msg.sender == owner, "Not owner");
        ownerCallCount++;
        message = newMessage;
        emit OwnerActionSuccess(msg.sender, "setMessage");
    }

    function setFeeRecipient(address newRecipient) external {
        require(msg.sender == owner, "Not owner");
        require(newRecipient != address(0), "Zero address");
        address old = feeRecipient;
        feeRecipient = newRecipient;
        ownerCallCount++;
        emit FeeRecipientChanged(old, newRecipient, msg.sender);
        emit OwnerActionSuccess(msg.sender, "setFeeRecipient");
    }

    function claimSpoof() external {
        require(msg.sender == owner, "Not owner");
        spoofSucceeded = true;
        emit SpoofClaimed(msg.sender, true);
    }

    function transferOwnership(address newOwner) external {
        require(msg.sender == owner, "Not owner");
        require(newOwner != address(0), "Zero address");
        address old = owner;
        owner = newOwner;
        emit OwnershipTransferred(old, newOwner);
    }

    function checkCallerVsOwner() external view returns (
        address caller,
        address contractOwner,
        bool callerIsOwner
    ) {
        return (msg.sender, owner, msg.sender == owner);
    }

    function getState() external view returns (
        address _owner,
        address _feeRecipient,
        string memory _message,
        uint256 _publicCalls,
        uint256 _ownerCalls,
        bool _spoofSucceeded
    ) {
        return (owner, feeRecipient, message, publicCallCount, ownerCallCount, spoofSucceeded);
    }
}
