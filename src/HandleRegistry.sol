// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title HandleRegistry
/// @notice Lets a wallet point at an X (Twitter) handle, together with a link to a post from
///         that handle. Word Bonds shows the handle next to the wallet's record, so people can
///         search a founder or KOL by name.
/// @dev The contract cannot read X. It only checks that the proof link is a post on the
///      claimed handle's own account (https://x.com/<handle>/status/<id>). Whether that post
///      really names this wallet is for the reader to check by opening the link. Several
///      wallets can claim the same handle; the site lists each one with its proof.
contract HandleRegistry {
    struct Claim {
        string handle;
        string proof;
        uint64 claimedAt;
    }

    uint256 public constant MAX_HANDLE = 15; // X's own limit
    uint256 public constant MAX_STATUS_ID = 25;

    mapping(address => Claim) private _claims;
    mapping(bytes32 => address[]) private _claimants;
    mapping(bytes32 => mapping(address => bool)) private _listed;

    event HandleClaimed(address indexed account, bytes32 indexed key, string handle, string proof);
    event HandleCleared(address indexed account, bytes32 indexed key);

    error BadHandle();
    error BadProof();
    error NoClaim();

    /// @notice Point the calling wallet at an X handle. Replaces any earlier claim.
    /// @param handle The handle without "@", 1 to 15 letters, digits or underscores.
    /// @param proof  Link to a post on that handle: https://x.com/<handle>/status/<id>
    ///               (twitter.com is accepted too).
    function claim(string calldata handle, string calldata proof) external {
        bytes memory h = bytes(handle);
        if (h.length == 0 || h.length > MAX_HANDLE) revert BadHandle();
        for (uint256 i; i < h.length; i++) {
            if (!_isHandleChar(h[i])) revert BadHandle();
        }
        if (!_proofMatches(bytes(proof), h)) revert BadProof();

        bytes32 key = keyOf(handle);
        Claim storage old = _claims[msg.sender];
        if (old.claimedAt != 0) {
            bytes32 oldKey = keyOf(old.handle);
            if (oldKey != key) emit HandleCleared(msg.sender, oldKey);
        }
        _claims[msg.sender] = Claim(handle, proof, uint64(block.timestamp));
        if (!_listed[key][msg.sender]) {
            _listed[key][msg.sender] = true;
            _claimants[key].push(msg.sender);
        }
        emit HandleClaimed(msg.sender, key, handle, proof);
    }

    /// @notice Remove the calling wallet's claim.
    function clear() external {
        Claim storage c = _claims[msg.sender];
        if (c.claimedAt == 0) revert NoClaim();
        bytes32 key = keyOf(c.handle);
        delete _claims[msg.sender];
        emit HandleCleared(msg.sender, key);
    }

    // ------------------------------------------------------------------ views

    function claimOf(address account) external view returns (string memory handle, string memory proof, uint64 claimedAt) {
        Claim storage c = _claims[account];
        return (c.handle, c.proof, c.claimedAt);
    }

    /// @notice Every wallet that has ever claimed this handle, oldest first. A wallet stays on
    ///         the list after it moves to another handle or clears, so check claimOf for each.
    function claimantCount(string calldata handle) external view returns (uint256) {
        return _claimants[keyOf(handle)].length;
    }

    function claimants(string calldata handle, uint256 start, uint256 count) external view returns (address[] memory out) {
        address[] storage all = _claimants[keyOf(handle)];
        if (start >= all.length) return new address[](0);
        uint256 end = start + count > all.length ? all.length : start + count;
        out = new address[](end - start);
        for (uint256 i = start; i < end; i++) {
            out[i - start] = all[i];
        }
    }

    /// @notice Handles are matched without regard to case, as X does.
    function keyOf(string memory handle) public pure returns (bytes32) {
        bytes memory h = bytes(handle);
        bytes memory lower = new bytes(h.length);
        for (uint256 i; i < h.length; i++) {
            lower[i] = _lower(h[i]);
        }
        return keccak256(lower);
    }

    // --------------------------------------------------------------- internal

    function _isHandleChar(bytes1 c) private pure returns (bool) {
        return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c == "_";
    }

    function _lower(bytes1 c) private pure returns (bytes1) {
        return (c >= "A" && c <= "Z") ? bytes1(uint8(c) + 32) : c;
    }

    /// Accepts exactly https://x.com/<handle>/status/<digits> or the twitter.com form,
    /// with the handle compared without regard to case.
    function _proofMatches(bytes memory p, bytes memory h) private pure returns (bool) {
        uint256 i;
        if (_startsWith(p, "https://x.com/")) i = 14;
        else if (_startsWith(p, "https://twitter.com/")) i = 20;
        else return false;
        if (p.length < i + h.length) return false;
        for (uint256 k; k < h.length; k++) {
            if (_lower(p[i + k]) != _lower(h[k])) return false;
        }
        i += h.length;
        bytes memory mid = "/status/";
        if (p.length < i + mid.length) return false;
        for (uint256 k; k < mid.length; k++) {
            if (p[i + k] != mid[k]) return false;
        }
        i += mid.length;
        uint256 digits = p.length - i;
        if (digits == 0 || digits > MAX_STATUS_ID) return false;
        for (; i < p.length; i++) {
            if (p[i] < "0" || p[i] > "9") return false;
        }
        return true;
    }

    function _startsWith(bytes memory p, bytes memory prefix) private pure returns (bool) {
        if (p.length < prefix.length) return false;
        for (uint256 i; i < prefix.length; i++) {
            if (p[i] != prefix[i]) return false;
        }
        return true;
    }
}
