// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {DiamondStorage} from "../DiamondStorage.sol";
import {TokenStorage} from "./ERC20Facet.sol";

library FeeVaultStorage {
    bytes32 constant FEE_VAULT_POSITION = keccak256("spoofwallet.feevault.storage");

    struct VaultState {
        uint256 accumulatedETH;
        uint256 accumulatedTokens;
        uint256 totalClaimedETH;
        uint256 totalClaimedTokens;
        uint256 feeRate; // basis points (e.g. 250 = 2.5%)
        uint256 lpFeesCut; // basis points for LP fees to recipient
        address pendingFeeRecipient;
        uint256 feeRecipientChangeRequestTime;
        uint256 timelockDuration;
        bool initialized;
        mapping(address => uint256) lastClaimTime;
    }

    function vaultStorage() internal pure returns (VaultState storage vs) {
        bytes32 position = FEE_VAULT_POSITION;
        assembly {
            vs.slot := position
        }
    }
}

contract FeeVaultFacet {
    event FeesDeposited(address indexed depositor, uint256 ethAmount, uint256 tokenAmount);
    event FeesClaimed(address indexed recipient, uint256 ethAmount, uint256 tokenAmount);
    event FeeRecipientChangeRequested(address indexed current, address indexed proposed, uint256 executeAfter);
    event FeeRecipientChanged(address indexed oldRecipient, address indexed newRecipient);
    event FeeRateUpdated(uint256 oldRate, uint256 newRate);
    event TimelockUpdated(uint256 oldDuration, uint256 newDuration);

    modifier onlyOwner() {
        require(msg.sender == DiamondStorage.diamondStorage().contractOwner, "Not owner");
        _;
    }

    modifier onlyFeeRecipient() {
        require(msg.sender == DiamondStorage.diamondStorage().feeRecipient, "Not fee recipient");
        _;
    }

    function initializeVault(uint256 _feeRate, uint256 _lpFeesCut, uint256 _timelockDuration) external onlyOwner {
        FeeVaultStorage.VaultState storage vs = FeeVaultStorage.vaultStorage();
        require(!vs.initialized, "Already initialized");
        require(_feeRate <= 1000, "Fee rate too high"); // max 10%
        require(_lpFeesCut <= 10000, "LP cut too high");

        vs.feeRate = _feeRate;
        vs.lpFeesCut = _lpFeesCut;
        vs.timelockDuration = _timelockDuration;
        vs.initialized = true;
    }

    // Simulate trading fees being deposited (like Clanker LP fee collection)
    function depositFees(uint256 tokenAmount) external payable {
        FeeVaultStorage.VaultState storage vs = FeeVaultStorage.vaultStorage();
        require(vs.initialized, "Not initialized");

        if (msg.value > 0) {
            vs.accumulatedETH += msg.value;
        }

        if (tokenAmount > 0) {
            TokenStorage.TokenState storage ts = TokenStorage.tokenStorage();
            require(ts.balances[msg.sender] >= tokenAmount, "Insufficient tokens");
            ts.balances[msg.sender] -= tokenAmount;
            ts.balances[address(this)] += tokenAmount;
            vs.accumulatedTokens += tokenAmount;
        }

        emit FeesDeposited(msg.sender, msg.value, tokenAmount);
    }

    // Fee recipient claims accumulated fees (like Clanker locker.claim())
    function claimFees() external onlyFeeRecipient {
        FeeVaultStorage.VaultState storage vs = FeeVaultStorage.vaultStorage();
        DiamondStorage.DiamondState storage ds = DiamondStorage.diamondStorage();

        uint256 ethShare = (vs.accumulatedETH * vs.lpFeesCut) / 10000;
        uint256 tokenShare = (vs.accumulatedTokens * vs.lpFeesCut) / 10000;

        require(ethShare > 0 || tokenShare > 0, "No fees to claim");

        vs.accumulatedETH -= ethShare;
        vs.accumulatedTokens -= tokenShare;
        vs.totalClaimedETH += ethShare;
        vs.totalClaimedTokens += tokenShare;
        vs.lastClaimTime[msg.sender] = block.timestamp;

        if (tokenShare > 0) {
            TokenStorage.TokenState storage ts = TokenStorage.tokenStorage();
            ts.balances[address(this)] -= tokenShare;
            ts.balances[msg.sender] += tokenShare;
        }

        if (ethShare > 0) {
            (bool ok,) = payable(msg.sender).call{value: ethShare}("");
            require(ok, "ETH transfer failed");
        }

        emit FeesClaimed(msg.sender, ethShare, tokenShare);
    }

    // Owner requests fee recipient change (2-step with timelock, like production contracts)
    function requestFeeRecipientChange(address _newRecipient) external onlyOwner {
        require(_newRecipient != address(0), "Zero address");
        FeeVaultStorage.VaultState storage vs = FeeVaultStorage.vaultStorage();

        vs.pendingFeeRecipient = _newRecipient;
        vs.feeRecipientChangeRequestTime = block.timestamp;

        emit FeeRecipientChangeRequested(
            DiamondStorage.diamondStorage().feeRecipient,
            _newRecipient,
            block.timestamp + vs.timelockDuration
        );
    }

    // Execute fee recipient change after timelock
    function executeFeeRecipientChange() external onlyOwner {
        FeeVaultStorage.VaultState storage vs = FeeVaultStorage.vaultStorage();
        require(vs.pendingFeeRecipient != address(0), "No pending change");
        require(
            block.timestamp >= vs.feeRecipientChangeRequestTime + vs.timelockDuration,
            "Timelock not expired"
        );

        DiamondStorage.DiamondState storage ds = DiamondStorage.diamondStorage();
        address old = ds.feeRecipient;
        ds.feeRecipient = vs.pendingFeeRecipient;
        vs.pendingFeeRecipient = address(0);
        vs.feeRecipientChangeRequestTime = 0;

        emit FeeRecipientChanged(old, ds.feeRecipient);
    }

    // Direct fee recipient change (no timelock — simulating Clanker-style)
    function setFeeRecipientDirect(address _newRecipient) external onlyOwner {
        require(_newRecipient != address(0), "Zero address");
        DiamondStorage.DiamondState storage ds = DiamondStorage.diamondStorage();
        address old = ds.feeRecipient;
        ds.feeRecipient = _newRecipient;
        emit FeeRecipientChanged(old, _newRecipient);
    }

    function updateFeeRate(uint256 _newRate) external onlyOwner {
        require(_newRate <= 1000, "Too high");
        FeeVaultStorage.VaultState storage vs = FeeVaultStorage.vaultStorage();
        uint256 old = vs.feeRate;
        vs.feeRate = _newRate;
        emit FeeRateUpdated(old, _newRate);
    }

    function getVaultInfo() external view returns (
        uint256 accETH,
        uint256 accTokens,
        uint256 claimedETH,
        uint256 claimedTokens,
        uint256 feeRate,
        uint256 lpFeesCut,
        address currentFeeRecipient,
        address pendingRecipient,
        uint256 timelockExpiry
    ) {
        FeeVaultStorage.VaultState storage vs = FeeVaultStorage.vaultStorage();
        DiamondStorage.DiamondState storage ds = DiamondStorage.diamondStorage();
        uint256 expiry = vs.feeRecipientChangeRequestTime > 0
            ? vs.feeRecipientChangeRequestTime + vs.timelockDuration
            : 0;
        return (
            vs.accumulatedETH,
            vs.accumulatedTokens,
            vs.totalClaimedETH,
            vs.totalClaimedTokens,
            vs.feeRate,
            vs.lpFeesCut,
            ds.feeRecipient,
            vs.pendingFeeRecipient,
            expiry
        );
    }
}
