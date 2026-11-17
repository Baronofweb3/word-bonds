// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {HandleRegistry} from "../src/HandleRegistry.sol";

contract HandleRegistryTest is Test {
    HandleRegistry reg;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    function setUp() public {
        reg = new HandleRegistry();
    }

    function _claim(address who, string memory h, string memory p) internal {
        vm.prank(who);
        reg.claim(h, p);
    }

    function test_claimStoresHandleAndProof() public {
        vm.warp(1_800_000_000);
        _claim(alice, "Baronoffweb3", "https://x.com/Baronoffweb3/status/1990000000000000001");
        (string memory h, string memory p, uint64 at) = reg.claimOf(alice);
        assertEq(h, "Baronoffweb3");
        assertEq(p, "https://x.com/Baronoffweb3/status/1990000000000000001");
        assertEq(at, 1_800_000_000);
        address[] memory c = reg.claimants("baronoffweb3", 0, 10);
        assertEq(c.length, 1);
        assertEq(c[0], alice);
    }

    function test_twitterDomainAndCaseInsensitiveProofAccepted() public {
        _claim(alice, "Baronoffweb3", "https://twitter.com/BARONOFFWEB3/status/42");
        assertEq(reg.claimantCount("BaRoNoFfWeB3"), 1);
    }

    function test_rejectsBadHandles() public {
        string[5] memory bad = ["", "has space", "way_too_long_handle", "dash-ed", "emoji\xf0\x9f\x98\x80"];
        for (uint256 i; i < bad.length; i++) {
            vm.prank(alice);
            vm.expectRevert(HandleRegistry.BadHandle.selector);
            reg.claim(bad[i], "https://x.com/a/status/1");
        }
    }

    function test_rejectsProofFromAnotherAccountOrShape() public {
        string[9] memory bad = [
            "https://x.com/someone_else/status/1",
            "https://x.com/baronoffweb3x/status/1",
            "https://x.com/baronoffweb3/status/",
            "https://x.com/baronoffweb3/status/12a",
            "https://x.com/baronoffweb3/status/1?s=20",
            "http://x.com/baronoffweb3/status/1",
            "https://evil.com/baronoffweb3/status/1",
            "https://x.com/baronoffweb3",
            "https://x.com/baronoffweb3/status/12345678901234567890123456"
        ];
        for (uint256 i; i < bad.length; i++) {
            vm.prank(alice);
            vm.expectRevert(HandleRegistry.BadProof.selector);
            reg.claim("baronoffweb3", bad[i]);
        }
    }

    function test_reclaimSameHandleDoesNotDuplicate() public {
        _claim(alice, "baron", "https://x.com/baron/status/1");
        _claim(alice, "Baron", "https://x.com/Baron/status/2");
        assertEq(reg.claimantCount("baron"), 1);
        (, string memory p,) = reg.claimOf(alice);
        assertEq(p, "https://x.com/Baron/status/2");
    }

    function test_movingToAnotherHandleReplacesClaim() public {
        _claim(alice, "first", "https://x.com/first/status/1");
        _claim(alice, "second", "https://x.com/second/status/2");
        (string memory h,,) = reg.claimOf(alice);
        assertEq(h, "second");
        // stays listed under the old handle; readers must check claimOf
        assertEq(reg.claimantCount("first"), 1);
        assertEq(reg.claimantCount("second"), 1);
    }

    function test_twoWalletsCanClaimTheSameHandle() public {
        _claim(alice, "baron", "https://x.com/baron/status/1");
        _claim(bob, "baron", "https://x.com/baron/status/2");
        address[] memory c = reg.claimants("baron", 0, 10);
        assertEq(c.length, 2);
        assertEq(c[1], bob);
    }

    function test_clearRemovesClaim() public {
        _claim(alice, "baron", "https://x.com/baron/status/1");
        vm.prank(alice);
        reg.clear();
        (string memory h,, uint64 at) = reg.claimOf(alice);
        assertEq(bytes(h).length, 0);
        assertEq(at, 0);
        vm.prank(alice);
        vm.expectRevert(HandleRegistry.NoClaim.selector);
        reg.clear();
    }

    function test_claimantsPaging() public {
        for (uint160 i = 1; i <= 5; i++) _claim(address(i), "x", "https://x.com/x/status/1");
        assertEq(reg.claimants("x", 3, 10).length, 2);
        assertEq(reg.claimants("x", 5, 10).length, 0);
        assertEq(reg.claimants("x", 1, 2)[1], address(3));
    }

    function test_keyIgnoresCase() public view {
        assertEq(reg.keyOf("BaronOfWeb3"), reg.keyOf("baronofweb3"));
        assertTrue(reg.keyOf("baron") != reg.keyOf("baron_"));
    }

    function testFuzz_onlyOwnProofAccepted(string calldata other) public {
        vm.assume(bytes(other).length > 0 && bytes(other).length < 20);
        vm.assume(reg.keyOf(other) != reg.keyOf("baron"));
        vm.prank(alice);
        vm.expectRevert();
        reg.claim("baron", string.concat("https://x.com/", other, "/status/1"));
    }
}
