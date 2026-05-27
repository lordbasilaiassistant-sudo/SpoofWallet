// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {DiamondStorage} from "../DiamondStorage.sol";
import {TokenStorage} from "./ERC20Facet.sol";

library BountyStorage {
    bytes32 constant BOUNTY_STORAGE_POSITION = keccak256("spoofwallet.bounty.storage");

    struct BountyState {
        uint256 totalBountyPool;
        uint256 claimedAmount;
        uint256 maxBountyPerExploit;
        mapping(bytes32 => Exploit) exploits;
        bytes32[] exploitIds;
        bool initialized;
    }

    struct Exploit {
        address discoverer;
        string description;
        uint256 reward;
        uint256 timestamp;
        bool paid;
        uint8 severity; // 0=info, 1=low, 2=medium, 3=high, 4=critical
    }

    function bountyStorage() internal pure returns (BountyState storage bs) {
        bytes32 position = BOUNTY_STORAGE_POSITION;
        assembly {
            bs.slot := position
        }
    }
}

contract BountyFacet {
    event BountyInitialized(uint256 totalPool, uint256 maxPerExploit);
    event ExploitSubmitted(bytes32 indexed exploitId, address indexed discoverer, string description, uint8 severity);
    event BountyPaid(bytes32 indexed exploitId, address indexed discoverer, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == DiamondStorage.diamondStorage().contractOwner, "Not owner");
        _;
    }

    function initializeBounty(uint256 _totalPool, uint256 _maxPerExploit) external onlyOwner {
        BountyStorage.BountyState storage bs = BountyStorage.bountyStorage();
        require(!bs.initialized, "Already initialized");

        // Transfer tokens from owner to this contract (Diamond)
        TokenStorage.TokenState storage ts = TokenStorage.tokenStorage();
        require(ts.balances[msg.sender] >= _totalPool, "Insufficient token balance");

        ts.balances[msg.sender] -= _totalPool;
        ts.balances[address(this)] += _totalPool;

        bs.totalBountyPool = _totalPool;
        bs.maxBountyPerExploit = _maxPerExploit;
        bs.initialized = true;

        emit BountyInitialized(_totalPool, _maxPerExploit);
    }

    function submitExploit(string calldata _description, uint8 _severity) external returns (bytes32) {
        require(_severity <= 4, "Invalid severity");
        BountyStorage.BountyState storage bs = BountyStorage.bountyStorage();
        require(bs.initialized, "Bounty not initialized");

        bytes32 exploitId = keccak256(abi.encodePacked(msg.sender, block.timestamp, _description));
        require(bs.exploits[exploitId].discoverer == address(0), "Duplicate");

        bs.exploits[exploitId] = BountyStorage.Exploit({
            discoverer: msg.sender,
            description: _description,
            reward: 0,
            timestamp: block.timestamp,
            paid: false,
            severity: _severity
        });
        bs.exploitIds.push(exploitId);

        emit ExploitSubmitted(exploitId, msg.sender, _description, _severity);
        return exploitId;
    }

    function approveBounty(bytes32 _exploitId, uint256 _amount) external onlyOwner {
        BountyStorage.BountyState storage bs = BountyStorage.bountyStorage();
        BountyStorage.Exploit storage exploit = bs.exploits[_exploitId];

        require(exploit.discoverer != address(0), "Exploit not found");
        require(!exploit.paid, "Already paid");
        require(_amount <= bs.maxBountyPerExploit, "Exceeds max per exploit");
        require(bs.claimedAmount + _amount <= bs.totalBountyPool, "Exceeds pool");

        TokenStorage.TokenState storage ts = TokenStorage.tokenStorage();
        ts.balances[address(this)] -= _amount;
        ts.balances[exploit.discoverer] += _amount;

        exploit.reward = _amount;
        exploit.paid = true;
        bs.claimedAmount += _amount;

        emit BountyPaid(_exploitId, exploit.discoverer, _amount);
    }

    function getBountyInfo() external view returns (
        uint256 totalPool,
        uint256 claimed,
        uint256 remaining,
        uint256 maxPerExploit,
        uint256 exploitCount
    ) {
        BountyStorage.BountyState storage bs = BountyStorage.bountyStorage();
        return (
            bs.totalBountyPool,
            bs.claimedAmount,
            bs.totalBountyPool - bs.claimedAmount,
            bs.maxBountyPerExploit,
            bs.exploitIds.length
        );
    }

    function getExploit(bytes32 _exploitId) external view returns (
        address discoverer,
        string memory description,
        uint256 reward,
        uint256 timestamp,
        bool paid,
        uint8 severity
    ) {
        BountyStorage.Exploit storage e = BountyStorage.bountyStorage().exploits[_exploitId];
        return (e.discoverer, e.description, e.reward, e.timestamp, e.paid, e.severity);
    }

    function getExploitCount() external view returns (uint256) {
        return BountyStorage.bountyStorage().exploitIds.length;
    }

    function getExploitIdAtIndex(uint256 index) external view returns (bytes32) {
        return BountyStorage.bountyStorage().exploitIds[index];
    }
}
