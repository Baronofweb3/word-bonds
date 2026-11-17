// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The part of a TapeOut processor (X Layer, chain 196) that Word Bonds reads.
/// @dev Signatures taken from the TapeSynth toolchain's ABI for the deployed processors.
///      Bits are packed LSB-first into ceil(n/8) bytes (TAP-02 section 5).
interface ITapeOutProcessor {
    /// @notice Evaluate a taped-out combinational circuit. Free to call, changes nothing.
    function eval(uint256 circuitId, bytes calldata inputs) external view returns (bytes memory outputs);

    /// @notice Shape of a taped-out circuit.
    function circuitInfo(uint256 circuitId)
        external
        view
        returns (uint32 nIn, uint32 nOut, uint32 nState, uint32 gateCount);
}
