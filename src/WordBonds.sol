// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ITapeOutProcessor} from "./ITapeOutProcessor.sol";

/// @title Word Bonds
/// @notice A maker locks a bond behind a public promise that a set of wallets will keep
///         holding a token until a date. A TapeOut circuit decides whether the promise is
///         kept or broken. Kept: the maker gets the bond back. Broken: the bond is slashed.
///
/// @dev Version 1 supports one promise type, the "hold rule" (circuits/hold_rule.v):
///        inputs  held[16] floor[16] expired[1]   (LSB-first, 5 bytes)
///        outputs breach[1] release[1]            (1 byte)
///      The contract only gathers facts (balances, time). The verdict comes from the circuit.
///
///      Unaudited prototype. See docs/SPEC.md for the threat model and known limits.
contract WordBonds {
    // ------------------------------------------------------------------ types

    enum Status {
        None,
        Active,
        Kept,
        Broken
    }

    struct Template {
        ITapeOutProcessor processor;
        uint256 circuitId;
    }

    struct Bond {
        address maker;
        address token;
        uint64 createdAt;
        uint64 deadline;
        uint16 floorBps;
        Status status;
        uint32 templateId;
        uint256 amount; // bond held by this contract, in native currency
        uint256 baseline; // total token balance of `wallets` when the bond was created
        address[] wallets;
        string statement;
    }

    /// @notice A maker's public track record. Values are in native currency.
    struct Record {
        uint32 kept;
        uint32 broken;
        uint256 keptValue;
        uint256 brokenValue;
    }

    // -------------------------------------------------------------- constants

    uint256 public constant BPS = 10_000;
    /// @notice Share of a slashed bond paid to whoever proves the breach.
    uint256 public constant BOUNTY_BPS = 1_000;
    uint256 public constant MAX_FEE_BPS = 300;
    uint256 public constant MAX_WALLETS = 8;
    uint256 public constant MIN_DURATION = 1 days;
    uint256 public constant MAX_DURATION = 5 * 365 days;
    uint256 public constant MAX_STATEMENT_BYTES = 280;
    /// @notice Gas given to each token balance read.
    uint256 public constant BALANCE_GAS = 100_000;
    /// @dev Gas that must be left before a balance read so the read always gets BALANCE_GAS
    ///      (a call can forward at most 63/64 of the gas left).
    uint256 private constant BALANCE_GAS_RESERVE = 110_000;

    uint32 private constant RULE_INPUT_BITS = 33;
    uint32 private constant RULE_OUTPUT_BITS = 2;

    // ---------------------------------------------------------------- storage

    /// @notice Can add promise templates. Has no power over bonds or funds.
    address public admin;
    address public pendingAdmin;
    /// @notice Is credited the creation fee.
    address public immutable treasury;
    /// @notice Is credited the slashed bond, minus the bounty. Fixed at deployment.
    address public immutable slashSink;
    /// @notice Creation fee in basis points of the amount sent. Fixed at deployment.
    uint256 public immutable feeBps;

    Template[] private _templates;
    Bond[] private _bonds;
    mapping(address maker => Record) public records;
    mapping(address maker => uint256[]) private _bondsOf;
    /// @notice Total native currency held for active bonds.
    uint256 public totalActive;
    /// @notice Fees and slashed funds waiting to be collected by the treasury or slash sink.
    mapping(address account => uint256) public owed;

    uint256 private _lock = 1;

    // ----------------------------------------------------------------- events

    event TemplateAdded(uint32 indexed templateId, address indexed processor, uint256 circuitId);
    event BondCreated(
        uint256 indexed bondId,
        address indexed maker,
        address indexed token,
        uint32 templateId,
        uint256 amount,
        uint256 baseline,
        uint16 floorBps,
        uint64 deadline,
        address[] wallets,
        string statement
    );
    event BondBroken(uint256 indexed bondId, address indexed challenger, uint256 heldBps, uint256 bounty, uint256 slashed);
    event BondKept(uint256 indexed bondId, address indexed maker, uint256 amount);
    event Withdrawn(address indexed account, uint256 value);
    event AdminTransferStarted(address indexed from, address indexed to);
    event AdminTransferred(address indexed from, address indexed to);

    // ----------------------------------------------------------------- errors

    error NotAdmin();
    error NotPendingAdmin();
    error ZeroAddress();
    error FeeTooHigh();
    error BadCircuitShape();
    error UnknownTemplate();
    error UnknownBond();
    error NotActive();
    error TokenHasNoCode();
    error BadWalletCount();
    error DuplicateWallet();
    error BadFloor();
    error BadDeadline();
    error StatementTooLong();
    error NoBond();
    error BalanceReadFailed();
    error ZeroBaseline();
    error NotBreached();
    error NotReleasable();
    error InvalidVerdict();
    error NotEnoughGas();
    error TransferFailed();
    error Reentrancy();
    error NothingOwed();

    // -------------------------------------------------------------- modifiers

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    // ------------------------------------------------------------ constructor

    constructor(address admin_, address treasury_, address slashSink_, uint256 feeBps_) {
        if (admin_ == address(0) || treasury_ == address(0) || slashSink_ == address(0)) revert ZeroAddress();
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        admin = admin_;
        treasury = treasury_;
        slashSink = slashSink_;
        feeBps = feeBps_;
    }

    // ------------------------------------------------------------------ admin

    /// @notice Register a taped-out circuit as a promise template. Templates can never be
    ///         changed or removed, so a bond's rule is fixed for its whole life.
    function addTemplate(ITapeOutProcessor processor, uint256 circuitId) external returns (uint32 templateId) {
        if (msg.sender != admin) revert NotAdmin();
        if (address(processor).code.length == 0) revert BadCircuitShape();
        (uint32 nIn, uint32 nOut, uint32 nState,) = processor.circuitInfo(circuitId);
        if (nIn != RULE_INPUT_BITS || nOut != RULE_OUTPUT_BITS || nState != 0) revert BadCircuitShape();
        templateId = uint32(_templates.length);
        _templates.push(Template(processor, circuitId));
        emit TemplateAdded(templateId, address(processor), circuitId);
    }

    function transferAdmin(address to) external {
        if (msg.sender != admin) revert NotAdmin();
        pendingAdmin = to;
        emit AdminTransferStarted(msg.sender, to);
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotPendingAdmin();
        emit AdminTransferred(admin, msg.sender);
        admin = msg.sender;
        pendingAdmin = address(0);
    }

    // ------------------------------------------------------------------ bonds

    /// @notice Lock a bond behind the promise "these wallets keep at least `floorBps` of what
    ///         they hold now, until `deadline`". The amount sent, minus the fee, is the bond.
    /// @param templateId Promise template (rule circuit) to bind this bond to.
    /// @param token      ERC-20 token the wallets hold.
    /// @param wallets    1 to 8 distinct wallets whose combined balance is watched.
    /// @param floorBps   Share of today's combined balance that must stay, 1 to 10000.
    /// @param deadline   When the promise ends (unix seconds).
    /// @param statement  Short public wording of the promise, for display only.
    function createBond(
        uint32 templateId,
        address token,
        address[] calldata wallets,
        uint16 floorBps,
        uint64 deadline,
        string calldata statement
    ) external payable nonReentrant returns (uint256 bondId) {
        if (templateId >= _templates.length) revert UnknownTemplate();
        if (token.code.length == 0) revert TokenHasNoCode();
        if (wallets.length == 0 || wallets.length > MAX_WALLETS) revert BadWalletCount();
        if (floorBps == 0 || floorBps > BPS) revert BadFloor();
        if (deadline < block.timestamp + MIN_DURATION || deadline > block.timestamp + MAX_DURATION) {
            revert BadDeadline();
        }
        if (bytes(statement).length > MAX_STATEMENT_BYTES) revert StatementTooLong();

        uint256 fee = (msg.value * feeBps) / BPS;
        uint256 amount = msg.value - fee;
        if (amount == 0) revert NoBond();

        uint256 baseline = _baseline(token, wallets);
        if (baseline == 0) revert ZeroBaseline();

        bondId = _bonds.length;
        _bonds.push(
            Bond({
                maker: msg.sender,
                token: token,
                createdAt: uint64(block.timestamp),
                deadline: deadline,
                floorBps: floorBps,
                status: Status.Active,
                templateId: templateId,
                amount: amount,
                baseline: baseline,
                wallets: wallets,
                statement: statement
            })
        );
        _bondsOf[msg.sender].push(bondId);
        totalActive += amount;

        _emitCreated(bondId);

        if (fee != 0) owed[treasury] += fee;
    }

    /// @notice Slash a bond whose promise is broken right now. Anyone can call.
    ///         The caller receives the bounty; the rest goes to the slash sink.
    function challenge(uint256 bondId) external nonReentrant {
        Bond storage b = _active(bondId);
        (uint256 heldBps, bool breach,) = _verdict(b);
        if (!breach) revert NotBreached();

        uint256 amount = b.amount;
        uint256 bounty = (amount * BOUNTY_BPS) / BPS;
        uint256 slashed = amount - bounty;

        b.status = Status.Broken;
        totalActive -= amount;
        Record storage r = records[b.maker];
        r.broken += 1;
        r.brokenValue += amount;

        emit BondBroken(bondId, msg.sender, heldBps, bounty, slashed);

        // The sink is credited, not paid, so a sink that rejects funds can never block a slash.
        owed[slashSink] += slashed;
        _send(msg.sender, bounty);
    }

    /// @notice Return a bond to its maker once the deadline has passed and the promise still
    ///         holds. Anyone can call; the funds only ever go to the maker.
    function release(uint256 bondId) external nonReentrant {
        Bond storage b = _active(bondId);
        (,, bool releasable) = _verdict(b);
        if (!releasable) revert NotReleasable();

        uint256 amount = b.amount;
        address maker = b.maker;

        b.status = Status.Kept;
        totalActive -= amount;
        Record storage r = records[maker];
        r.kept += 1;
        r.keptValue += amount;

        emit BondKept(bondId, maker, amount);

        _send(maker, amount);
    }

    /// @notice Pay out what `account` (the treasury or the slash sink) is owed. Anyone can
    ///         call; the funds only ever go to `account`.
    function withdraw(address account) external nonReentrant {
        uint256 value = owed[account];
        if (value == 0) revert NothingOwed();
        owed[account] = 0;
        emit Withdrawn(account, value);
        _send(account, value);
    }

    // ------------------------------------------------------------------ views

    /// @notice What the rule circuit says about a bond right now.
    /// @return heldBps    Current combined balance, in basis points of the baseline (max 65535).
    /// @return breach     True if the bond can be slashed now.
    /// @return releasable True if the bond can be returned to the maker now.
    function check(uint256 bondId) external view returns (uint256 heldBps, bool breach, bool releasable) {
        if (bondId >= _bonds.length) revert UnknownBond();
        return _verdict(_bonds[bondId]);
    }

    function getBond(uint256 bondId) external view returns (Bond memory) {
        if (bondId >= _bonds.length) revert UnknownBond();
        return _bonds[bondId];
    }

    function bondCount() external view returns (uint256) {
        return _bonds.length;
    }

    function bondsOf(address maker) external view returns (uint256[] memory) {
        return _bondsOf[maker];
    }

    function getTemplate(uint32 templateId) external view returns (Template memory) {
        if (templateId >= _templates.length) revert UnknownTemplate();
        return _templates[templateId];
    }

    function templateCount() external view returns (uint256) {
        return _templates.length;
    }

    // --------------------------------------------------------------- internal

    function _active(uint256 bondId) private view returns (Bond storage b) {
        if (bondId >= _bonds.length) revert UnknownBond();
        b = _bonds[bondId];
        if (b.status != Status.Active) revert NotActive();
    }

    /// @dev Check the wallet list and add up what the wallets hold today.
    function _baseline(address token, address[] calldata wallets) private view returns (uint256 baseline) {
        for (uint256 i; i < wallets.length; ++i) {
            address w = wallets[i];
            if (w == address(0)) revert ZeroAddress();
            for (uint256 j; j < i; ++j) {
                if (wallets[j] == w) revert DuplicateWallet();
            }
            (bool ok, uint256 bal) = _balanceOf(token, w);
            if (!ok) revert BalanceReadFailed();
            baseline += bal; // reverts on overflow, which no sane token can reach
        }
    }

    function _emitCreated(uint256 bondId) private {
        Bond storage b = _bonds[bondId];
        emit BondCreated(
            bondId, b.maker, b.token, b.templateId, b.amount, b.baseline, b.floorBps, b.deadline, b.wallets, b.statement
        );
    }

    /// @dev Gather the facts, ask the circuit, and sanity-check its answer.
    function _verdict(Bond storage b) private view returns (uint256 heldBps, bool breach, bool releasable) {
        heldBps = _heldBps(b);
        bool expired = block.timestamp >= b.deadline;

        // held[16] floor[16] expired[1], LSB-first.
        bytes memory inputs = new bytes(5);
        inputs[0] = bytes1(uint8(heldBps));
        inputs[1] = bytes1(uint8(heldBps >> 8));
        inputs[2] = bytes1(uint8(b.floorBps));
        inputs[3] = bytes1(uint8(b.floorBps >> 8));
        inputs[4] = expired ? bytes1(0x01) : bytes1(0x00);

        Template storage t = _templates[b.templateId];
        bytes memory out = t.processor.eval(t.circuitId, inputs);
        if (out.length == 0) revert InvalidVerdict();
        uint8 bits = uint8(out[0]);
        breach = bits & 1 != 0;
        releasable = bits & 2 != 0;
        if (breach && releasable) revert InvalidVerdict();
    }

    /// @dev Combined balance of the bond's wallets, as basis points of the baseline, capped at
    ///      65535. A balance read that fails counts as zero, so a token that stops answering
    ///      cannot be used to dodge a slash.
    function _heldBps(Bond storage b) private view returns (uint256) {
        uint256 total;
        uint256 n = b.wallets.length;
        for (uint256 i; i < n; ++i) {
            (bool ok, uint256 bal) = _balanceOf(b.token, b.wallets[i]);
            if (ok) {
                unchecked {
                    uint256 sum = total + bal;
                    total = sum < total ? type(uint256).max : sum; // saturate
                }
            }
        }
        if (total > type(uint256).max / BPS) return type(uint16).max;
        uint256 bps = (total * BPS) / b.baseline;
        return bps > type(uint16).max ? type(uint16).max : bps;
    }

    /// @dev Read a token balance with a fixed gas allowance. Reverts if the caller left too
    ///      little gas, so nobody can starve the read to fake an empty wallet. (A starved read
    ///      also leaves too little gas to finish the transaction, so this is a second guard.)
    function _balanceOf(address token, address wallet) private view returns (bool ok, uint256 bal) {
        if (gasleft() < BALANCE_GAS_RESERVE) revert NotEnoughGas();
        bytes memory data = abi.encodeWithSelector(0x70a08231, wallet); // balanceOf(address)
        uint256 size;
        // Only the first 32 bytes of the answer are copied, so an oversized answer costs nothing.
        assembly ("memory-safe") {
            ok := staticcall(BALANCE_GAS, token, add(data, 0x20), mload(data), 0x00, 0x20)
            size := returndatasize()
            bal := mload(0x00)
        }
        if (!ok || size < 32) return (false, 0);
    }

    function _send(address to, uint256 value) private {
        (bool ok,) = to.call{value: value}("");
        if (!ok) revert TransferFailed();
    }
}
