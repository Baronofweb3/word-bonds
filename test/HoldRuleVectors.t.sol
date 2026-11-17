// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockProcessor} from "./mocks/MockProcessor.sol";

/// @notice Ties the tests to the real circuit. circuits/hold_rule.vectors.txt is produced by
///         simulating the synthesised NAND netlist (tools/vectors.mjs). Every line is
///         "inputsHex outputsHex". The stand-in processor used by the other tests must give
///         the same answer as the netlist on every vector.
contract HoldRuleVectorsTest is Test {
    function test_mockProcessorMatchesTheSynthesisedNetlist() public {
        MockProcessor proc = new MockProcessor();
        string memory path = "circuits/hold_rule.vectors.txt";
        uint256 n;
        while (true) {
            string memory line = vm.readLine(path);
            if (bytes(line).length == 0) break;
            string[] memory parts = vm.split(line, " ");
            bytes memory inputs = vm.parseBytes(string.concat("0x", parts[0]));
            bytes memory expected = vm.parseBytes(string.concat("0x", parts[1]));
            assertEq(proc.eval(0, inputs), expected, line);
            n++;
        }
        assertGt(n, 4000, "vector file is missing or short");
    }

    /// The rule itself: breach iff held < floor, release iff expired and not breached.
    function testFuzz_ruleSemantics(uint16 held, uint16 floor, bool expired) public {
        MockProcessor proc = new MockProcessor();
        bytes memory inputs = abi.encodePacked(
            uint8(held), uint8(held >> 8), uint8(floor), uint8(floor >> 8), expired ? uint8(1) : uint8(0)
        );
        uint8 out = uint8(proc.eval(0, inputs)[0]);
        bool breach = out & 1 != 0;
        bool release = out & 2 != 0;
        assertEq(breach, held < floor);
        assertEq(release, expired && !(held < floor));
        assertFalse(breach && release);
    }
}
