// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ITapeOutProcessor} from "../../src/ITapeOutProcessor.sol";

/// @notice Stand-in for a TapeOut processor holding the hold-rule circuit.
/// @dev Its answers are checked against a simulation of the real synthesised netlist in
///      HoldRuleVectors.t.sol, so tests that use it are tests against the circuit's behaviour.
contract MockProcessor is ITapeOutProcessor {
    enum Mode {
        Rule,
        BothBits,
        Empty,
        Revert
    }

    Mode public mode;
    uint32 public nIn = 33;
    uint32 public nOut = 2;
    uint32 public nState = 0;

    function setMode(Mode m) external {
        mode = m;
    }

    function setShape(uint32 nIn_, uint32 nOut_, uint32 nState_) external {
        nIn = nIn_;
        nOut = nOut_;
        nState = nState_;
    }

    function circuitInfo(uint256) external view returns (uint32, uint32, uint32, uint32) {
        return (nIn, nOut, nState, 119);
    }

    function eval(uint256, bytes calldata inputs) external view returns (bytes memory out) {
        if (mode == Mode.Revert) revert("processor down");
        if (mode == Mode.Empty) return "";
        out = new bytes(1);
        if (mode == Mode.BothBits) {
            out[0] = 0x03;
            return out;
        }
        // Lenient read like the deployed evaluator: missing bytes read as 0.
        uint256 held = _u16(inputs, 0);
        uint256 floor = _u16(inputs, 2);
        bool expired = inputs.length > 4 && uint8(inputs[4]) & 1 != 0;
        bool breach = held < floor;
        bool release = expired && !breach;
        out[0] = bytes1((breach ? 1 : 0) | (release ? 2 : 0));
    }

    function _u16(bytes calldata b, uint256 at) private pure returns (uint256 v) {
        if (b.length > at) v = uint8(b[at]);
        if (b.length > at + 1) v |= uint256(uint8(b[at + 1])) << 8;
    }
}
