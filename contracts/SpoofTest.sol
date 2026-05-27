// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract SpoofTest {
    address public owner;
    string public message;
    uint256 public publicCallCount;
    uint256 public ownerCallCount;

    event PublicCalled(address indexed caller, uint256 count);
    event OwnerCalled(address indexed caller, string newMessage, uint256 count);

    constructor() {
        owner = msg.sender;
        message = "Only the real owner can change this";
    }

    function callPublic() external {
        publicCallCount++;
        emit PublicCalled(msg.sender, publicCallCount);
    }

    function callOwnerOnly(string calldata newMessage) external {
        require(msg.sender == owner, "SpoofTest: caller is not the owner");
        ownerCallCount++;
        message = newMessage;
        emit OwnerCalled(msg.sender, newMessage, ownerCallCount);
    }
}
