// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {DiamondStorage} from "../DiamondStorage.sol";

library TokenStorage {
    bytes32 constant TOKEN_STORAGE_POSITION = keccak256("spoofwallet.token.storage");

    struct TokenState {
        string name;
        string symbol;
        uint8 decimals;
        uint256 totalSupply;
        mapping(address => uint256) balances;
        mapping(address => mapping(address => uint256)) allowances;
        bool initialized;
    }

    function tokenStorage() internal pure returns (TokenState storage ts) {
        bytes32 position = TOKEN_STORAGE_POSITION;
        assembly {
            ts.slot := position
        }
    }
}

contract ERC20Facet {
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function initializeToken(
        string calldata _name,
        string calldata _symbol,
        uint256 _totalSupply,
        address _recipient
    ) external {
        TokenStorage.TokenState storage ts = TokenStorage.tokenStorage();
        require(!ts.initialized, "Already initialized");

        require(msg.sender == DiamondStorage.diamondStorage().contractOwner, "Not owner");

        ts.name = _name;
        ts.symbol = _symbol;
        ts.decimals = 18;
        ts.totalSupply = _totalSupply;
        ts.balances[_recipient] = _totalSupply;
        ts.initialized = true;

        emit Transfer(address(0), _recipient, _totalSupply);
    }

    function name() external view returns (string memory) {
        return TokenStorage.tokenStorage().name;
    }

    function symbol() external view returns (string memory) {
        return TokenStorage.tokenStorage().symbol;
    }

    function decimals() external view returns (uint8) {
        return TokenStorage.tokenStorage().decimals;
    }

    function totalSupply() external view returns (uint256) {
        return TokenStorage.tokenStorage().totalSupply;
    }

    function balanceOf(address account) external view returns (uint256) {
        return TokenStorage.tokenStorage().balances[account];
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        TokenStorage.TokenState storage ts = TokenStorage.tokenStorage();
        require(ts.balances[msg.sender] >= amount, "Insufficient balance");
        require(to != address(0), "Zero address");

        ts.balances[msg.sender] -= amount;
        ts.balances[to] += amount;

        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        require(spender != address(0), "Zero address");
        TokenStorage.tokenStorage().allowances[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function allowance(address _owner, address spender) external view returns (uint256) {
        return TokenStorage.tokenStorage().allowances[_owner][spender];
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        TokenStorage.TokenState storage ts = TokenStorage.tokenStorage();
        require(ts.balances[from] >= amount, "Insufficient balance");
        require(ts.allowances[from][msg.sender] >= amount, "Insufficient allowance");
        require(to != address(0), "Zero address");

        ts.balances[from] -= amount;
        ts.allowances[from][msg.sender] -= amount;
        ts.balances[to] += amount;

        emit Transfer(from, to, amount);
        return true;
    }
}
