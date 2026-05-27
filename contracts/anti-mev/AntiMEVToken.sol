// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AntiMEVStorage} from "./AntiMEVStorage.sol";

/// @title AntiMEVToken -- ERC-20 with transfer-level bot detection
/// @author THRYX Research (Ada Lin)
///
/// @notice This token applies transfer-level taxes on bot-classified addresses.
///         It works in conjunction with AntiMEVHook (which handles swap-level
///         detection) but also catches bots that try to transfer tokens
///         directly (e.g., to a different wallet before selling).
///
/// TRANSFER TAX LOGIC:
///   - If sender OR recipient has botScore >= 128, apply botTaxBps
///   - If sender is whitelisted, no tax
///   - If recipient is a known DEX router, this is a sell -- check seller profile
///   - Tax is burned (reduces supply) or sent to treasury
///
/// ANTI-TRANSFER LAUNDERING:
///   - When a bot-flagged address transfers to a new address, the new address
///     inherits 50% of the bot score.  This prevents bots from cycling through
///     wallets to shed their score.
///
/// COMPATIBLE WITH:
///   - Clanker V4 factory (implements standard ERC-20 + admin pattern)
///   - Standalone deployment via Diamond proxy (as a facet)
///   - OpenZeppelin IERC20 consumers

contract AntiMEVToken {
    // ---------------------------------------------------------------
    //  ERC-20 Storage (separate slot from AntiMEV to avoid collision)
    // ---------------------------------------------------------------
    bytes32 constant TOKEN_SLOT = keccak256("thryx.antimev.token.v1");

    struct TokenState {
        string name;
        string symbol;
        uint8 decimals;
        uint256 totalSupply;
        mapping(address => uint256) balances;
        mapping(address => mapping(address => uint256)) allowances;
        bool initialized;
        address admin;           // Clanker-compatible admin
        address originalAdmin;   // Clanker-compatible originalAdmin
        // DEX router registry for sell detection
        mapping(address => bool) isDexRouter;
    }

    function _ts() internal pure returns (TokenState storage ts) {
        bytes32 pos = TOKEN_SLOT;
        assembly { ts.slot := pos }
    }

    // ---------------------------------------------------------------
    //  Events
    // ---------------------------------------------------------------
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event AdminUpdated(address indexed oldAdmin, address indexed newAdmin);
    event BotTaxBurned(address indexed from, uint256 amount);
    event BotScoreInherited(address indexed from, address indexed to, uint8 inheritedScore);

    // ---------------------------------------------------------------
    //  Errors
    // ---------------------------------------------------------------
    error InsufficientBalance();
    error InsufficientAllowance();
    error ZeroAddress();
    error NotAdmin();
    error AlreadyInitialized();

    // ---------------------------------------------------------------
    //  Modifiers
    // ---------------------------------------------------------------
    modifier onlyAdmin() {
        if (msg.sender != _ts().admin) revert NotAdmin();
        _;
    }

    // ===============================================================
    //  INITIALIZATION
    // ===============================================================

    /// @notice Initialize the token (Clanker-compatible pattern)
    function initializeToken(
        string calldata _name,
        string calldata _symbol,
        uint256 _totalSupply,
        address _recipient,
        address _admin
    ) external {
        TokenState storage ts = _ts();
        if (ts.initialized) revert AlreadyInitialized();

        ts.name = _name;
        ts.symbol = _symbol;
        ts.decimals = 18;
        ts.totalSupply = _totalSupply;
        ts.balances[_recipient] = _totalSupply;
        ts.admin = _admin;
        ts.originalAdmin = _admin;
        ts.initialized = true;

        emit Transfer(address(0), _recipient, _totalSupply);
    }

    // ===============================================================
    //  ERC-20 STANDARD INTERFACE
    // ===============================================================

    function name() external view returns (string memory) { return _ts().name; }
    function symbol() external view returns (string memory) { return _ts().symbol; }
    function decimals() external view returns (uint8) { return _ts().decimals; }
    function totalSupply() external view returns (uint256) { return _ts().totalSupply; }
    function balanceOf(address account) external view returns (uint256) {
        return _ts().balances[account];
    }
    function allowance(address owner_, address spender) external view returns (uint256) {
        return _ts().allowances[owner_][spender];
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        if (spender == address(0)) revert ZeroAddress();
        _ts().allowances[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        TokenState storage ts = _ts();
        uint256 currentAllowance = ts.allowances[from][msg.sender];
        if (currentAllowance < amount) revert InsufficientAllowance();

        // Spend allowance (skip if max approval for gas efficiency)
        if (currentAllowance != type(uint256).max) {
            ts.allowances[from][msg.sender] = currentAllowance - amount;
        }

        _transfer(from, to, amount);
        return true;
    }

    // ===============================================================
    //  CLANKER-COMPATIBLE ADMIN INTERFACE
    // ===============================================================

    function admin() external view returns (address) { return _ts().admin; }
    function originalAdmin() external view returns (address) { return _ts().originalAdmin; }

    function updateAdmin(address _newAdmin) external onlyAdmin {
        if (_newAdmin == address(0)) revert ZeroAddress();
        TokenState storage ts = _ts();
        address old = ts.admin;
        ts.admin = _newAdmin;
        emit AdminUpdated(old, _newAdmin);
    }

    // ===============================================================
    //  ADMIN FUNCTIONS
    // ===============================================================

    /// @notice Register a DEX router address for sell-detection
    function setDexRouter(address _router, bool _status) external onlyAdmin {
        _ts().isDexRouter[_router] = _status;
    }

    // ===============================================================
    //  INTERNAL: ANTI-MEV TRANSFER LOGIC
    // ===============================================================

    /// @dev Core transfer with bot detection and taxation
    function _transfer(address from, address to, uint256 amount) internal {
        if (from == address(0) || to == address(0)) revert ZeroAddress();

        TokenState storage ts = _ts();
        if (ts.balances[from] < amount) revert InsufficientBalance();

        AntiMEVStorage.State storage s = AntiMEVStorage.state();
        AntiMEVStorage.AddressProfile storage senderProfile = s.profiles[from];
        AntiMEVStorage.AddressProfile storage recipientProfile = s.profiles[to];

        // --- Compute transfer tax ---
        uint256 taxAmount = 0;

        // Skip tax for whitelisted addresses
        if (!senderProfile.whitelisted && !recipientProfile.whitelisted) {
            uint16 taxBps = 0;

            // Bot-flagged sender: tax outgoing transfers
            if (senderProfile.botScore >= 128) {
                taxBps = s.config.botTaxBps;
            }
            // Bot-flagged recipient: tax incoming transfers (prevents
            // bots from receiving tokens to sandwich later)
            else if (recipientProfile.botScore >= 128) {
                taxBps = s.config.botTaxBps / 2; // half tax on receives
            }
            // Transfer to DEX router = sell, check for fast-sell penalty
            else if (ts.isDexRouter[to] && senderProfile.lastBuyBlock > 0) {
                uint64 holdBlocks = uint64(block.number) - senderProfile.lastBuyBlock;
                if (holdBlocks < uint64(s.config.minHoldBlocks)) {
                    // Fast sell via direct router call (bypassing hook)
                    // Apply a moderate penalty
                    taxBps = s.config.baseTaxBps * 5; // 5x base tax
                }
            }

            if (taxBps > 0) {
                taxAmount = (amount * uint256(taxBps)) / 10000;
                if (taxAmount > amount) taxAmount = amount; // safety cap
            }
        }

        // --- Anti-laundering: inherit bot score on transfer ---
        // When a flagged address sends tokens, the recipient inherits
        // half the score.  This prevents cycling through wallets.
        if (senderProfile.botScore >= 64 && !recipientProfile.whitelisted) {
            uint8 inherited = senderProfile.botScore / 2;
            if (inherited > recipientProfile.botScore) {
                recipientProfile.botScore = inherited;
                emit BotScoreInherited(from, to, inherited);
            }
        }

        // --- Execute transfer ---
        uint256 netAmount = amount - taxAmount;
        ts.balances[from] -= amount;
        ts.balances[to] += netAmount;
        emit Transfer(from, to, netAmount);

        // --- Handle tax: burn it (deflationary) ---
        if (taxAmount > 0) {
            ts.totalSupply -= taxAmount;
            emit Transfer(from, address(0), taxAmount);
            emit BotTaxBurned(from, taxAmount);
        }
    }
}
