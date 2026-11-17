// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {WordBonds} from "../src/WordBonds.sol";
import {ITapeOutProcessor} from "../src/ITapeOutProcessor.sol";
import {MockProcessor} from "./mocks/MockProcessor.sol";
import {MockToken} from "./mocks/MockToken.sol";

contract Reenterer {
    WordBonds public wb;
    uint256 public bondId;
    uint256 public attempts;
    uint256 public succeeded;
    bytes4 public lastError;

    constructor(WordBonds wb_) {
        wb = wb_;
    }

    function create(uint32 t, address token, address[] calldata w, uint16 f, uint64 d) external payable {
        bondId = wb.createBond{value: msg.value}(t, token, w, f, d, "");
    }

    function doChallenge(uint256 id) external {
        bondId = id;
        wb.challenge(id);
    }

    receive() external payable {
        attempts++;
        try wb.release(bondId) {
            succeeded++;
        } catch (bytes memory err) {
            lastError = bytes4(err);
        }
        try wb.challenge(bondId) {
            succeeded++;
        } catch {}
        try wb.withdraw(address(this)) {
            succeeded++;
        } catch {}
    }
}

contract RejectingSink {
    receive() external payable {
        revert("no thanks");
    }
}

contract WordBondsTest is Test {
    WordBonds wb;
    MockProcessor proc;
    MockToken token;

    address admin = makeAddr("admin");
    address treasury = makeAddr("treasury");
    address sink = makeAddr("sink");
    address maker = makeAddr("maker");
    address w1 = makeAddr("teamWallet1");
    address w2 = makeAddr("teamWallet2");
    address buyer = makeAddr("buyer");
    address challenger = makeAddr("challenger");

    uint256 constant FEE_BPS = 100; // 1%
    uint256 constant CIRCUIT_ID = 7;
    uint32 tpl;

    function setUp() public {
        vm.warp(1_800_000_000);
        proc = new MockProcessor();
        token = new MockToken();
        wb = new WordBonds(admin, treasury, sink, FEE_BPS);
        vm.prank(admin);
        tpl = wb.addTemplate(proc, CIRCUIT_ID);

        token.mint(w1, 600_000e18);
        token.mint(w2, 400_000e18);
        vm.deal(maker, 100 ether);
    }

    // ---------------------------------------------------------------- helpers

    function _wallets() internal view returns (address[] memory w) {
        w = new address[](2);
        w[0] = w1;
        w[1] = w2;
    }

    function _create(uint256 value, uint16 floorBps, uint64 duration) internal returns (uint256 id) {
        vm.prank(maker);
        id = wb.createBond{value: value}(
            tpl, address(token), _wallets(), floorBps, uint64(block.timestamp) + duration, "Team holds for 180 days"
        );
    }

    function _status(uint256 id) internal view returns (WordBonds.Status) {
        return wb.getBond(id).status;
    }

    function _assertSolvent() internal view {
        assertEq(address(wb).balance, wb.totalActive() + wb.owed(treasury) + wb.owed(sink), "contract not solvent");
    }

    // ----------------------------------------------------------- construction

    function test_constructor_rejectsBadConfig() public {
        vm.expectRevert(WordBonds.ZeroAddress.selector);
        new WordBonds(address(0), treasury, sink, 0);
        vm.expectRevert(WordBonds.ZeroAddress.selector);
        new WordBonds(admin, address(0), sink, 0);
        vm.expectRevert(WordBonds.ZeroAddress.selector);
        new WordBonds(admin, treasury, address(0), 0);
        vm.expectRevert(WordBonds.FeeTooHigh.selector);
        new WordBonds(admin, treasury, sink, 301);
    }

    // -------------------------------------------------------------- templates

    function test_addTemplate_onlyAdmin() public {
        vm.expectRevert(WordBonds.NotAdmin.selector);
        wb.addTemplate(proc, 1);
    }

    function test_addTemplate_rejectsWrongShape() public {
        vm.startPrank(admin);
        proc.setShape(32, 2, 0);
        vm.expectRevert(WordBonds.BadCircuitShape.selector);
        wb.addTemplate(proc, 1);
        proc.setShape(33, 1, 0);
        vm.expectRevert(WordBonds.BadCircuitShape.selector);
        wb.addTemplate(proc, 1);
        proc.setShape(33, 2, 1); // a circuit with memory is not a pure rule
        vm.expectRevert(WordBonds.BadCircuitShape.selector);
        wb.addTemplate(proc, 1);
        vm.expectRevert(WordBonds.BadCircuitShape.selector);
        wb.addTemplate(ITapeOutProcessor(makeAddr("notAContract")), 1);
        vm.stopPrank();
    }

    function test_template_isStoredAndReadable() public view {
        WordBonds.Template memory t = wb.getTemplate(tpl);
        assertEq(address(t.processor), address(proc));
        assertEq(t.circuitId, CIRCUIT_ID);
        assertEq(wb.templateCount(), 1);
    }

    function test_adminTransfer_isTwoStep() public {
        address next = makeAddr("next");
        vm.prank(admin);
        wb.transferAdmin(next);
        assertEq(wb.admin(), admin);
        vm.expectRevert(WordBonds.NotPendingAdmin.selector);
        wb.acceptAdmin();
        vm.prank(next);
        wb.acceptAdmin();
        assertEq(wb.admin(), next);
        vm.prank(admin);
        vm.expectRevert(WordBonds.NotAdmin.selector);
        wb.addTemplate(proc, 1);
    }

    // ----------------------------------------------------------------- create

    function test_create_locksBondAndTakesFee() public {
        uint256 id = _create(10 ether, 10_000, 180 days);
        WordBonds.Bond memory b = wb.getBond(id);
        assertEq(b.maker, maker);
        assertEq(b.amount, 9.9 ether);
        assertEq(b.baseline, 1_000_000e18);
        assertEq(b.floorBps, 10_000);
        assertEq(uint8(b.status), uint8(WordBonds.Status.Active));
        assertEq(b.wallets.length, 2);
        assertEq(wb.owed(treasury), 0.1 ether);
        assertEq(wb.totalActive(), 9.9 ether);
        assertEq(wb.bondsOf(maker).length, 1);
        _assertSolvent();

        (uint256 held, bool breach, bool releasable) = wb.check(id);
        assertEq(held, 10_000);
        assertFalse(breach);
        assertFalse(releasable);
    }

    function test_create_rejectsBadInput() public {
        address[] memory w = _wallets();
        uint64 d = uint64(block.timestamp + 30 days);
        vm.startPrank(maker);

        vm.expectRevert(WordBonds.UnknownTemplate.selector);
        wb.createBond{value: 1 ether}(99, address(token), w, 10_000, d, "");

        vm.expectRevert(WordBonds.TokenHasNoCode.selector);
        wb.createBond{value: 1 ether}(tpl, makeAddr("eoa"), w, 10_000, d, "");

        vm.expectRevert(WordBonds.BadWalletCount.selector);
        wb.createBond{value: 1 ether}(tpl, address(token), new address[](0), 10_000, d, "");

        vm.expectRevert(WordBonds.BadWalletCount.selector);
        wb.createBond{value: 1 ether}(tpl, address(token), new address[](9), 10_000, d, "");

        vm.expectRevert(WordBonds.BadFloor.selector);
        wb.createBond{value: 1 ether}(tpl, address(token), w, 0, d, "");

        vm.expectRevert(WordBonds.BadFloor.selector);
        wb.createBond{value: 1 ether}(tpl, address(token), w, 10_001, d, "");

        vm.expectRevert(WordBonds.BadDeadline.selector);
        wb.createBond{value: 1 ether}(tpl, address(token), w, 10_000, uint64(block.timestamp + 1 days - 1), "");

        vm.expectRevert(WordBonds.BadDeadline.selector);
        wb.createBond{value: 1 ether}(tpl, address(token), w, 10_000, uint64(block.timestamp + 5 * 365 days + 1), "");

        vm.expectRevert(WordBonds.NoBond.selector);
        wb.createBond{value: 0}(tpl, address(token), w, 10_000, d, "");

        vm.expectRevert(WordBonds.StatementTooLong.selector);
        wb.createBond{value: 1 ether}(tpl, address(token), w, 10_000, d, string(new bytes(281)));

        address[] memory dup = new address[](2);
        dup[0] = w1;
        dup[1] = w1;
        vm.expectRevert(WordBonds.DuplicateWallet.selector);
        wb.createBond{value: 1 ether}(tpl, address(token), dup, 10_000, d, "");

        address[] memory zero = new address[](1);
        vm.expectRevert(WordBonds.ZeroAddress.selector);
        wb.createBond{value: 1 ether}(tpl, address(token), zero, 10_000, d, "");

        address[] memory empty = new address[](1);
        empty[0] = makeAddr("holdsNothing");
        vm.expectRevert(WordBonds.ZeroBaseline.selector);
        wb.createBond{value: 1 ether}(tpl, address(token), empty, 10_000, d, "");

        vm.stopPrank();
    }

    function test_create_rejectsTokenThatCannotBeRead() public {
        token.setMode(MockToken.Mode.Revert);
        vm.prank(maker);
        vm.expectRevert(WordBonds.BalanceReadFailed.selector);
        wb.createBond{value: 1 ether}(tpl, address(token), _wallets(), 10_000, uint64(block.timestamp + 30 days), "");
    }

    // -------------------------------------------------------------- challenge

    function test_challenge_revertsWhilePromiseHolds() public {
        uint256 id = _create(10 ether, 10_000, 180 days);
        vm.prank(challenger);
        vm.expectRevert(WordBonds.NotBreached.selector);
        wb.challenge(id);
    }

    function test_challenge_slashesAfterASale() public {
        uint256 id = _create(10 ether, 10_000, 180 days);
        vm.prank(w1);
        token.transfer(buyer, 1); // one unit under the promised 100%

        (uint256 held, bool breach,) = wb.check(id);
        assertEq(held, 9_999);
        assertTrue(breach);

        vm.prank(challenger);
        wb.challenge(id);

        assertEq(uint8(_status(id)), uint8(WordBonds.Status.Broken));
        assertEq(challenger.balance, 0.99 ether); // 10% bounty
        assertEq(wb.owed(sink), 8.91 ether);
        assertEq(wb.totalActive(), 0);
        (uint32 kept, uint32 broken, uint256 keptValue, uint256 brokenValue) = wb.records(maker);
        assertEq(kept, 0);
        assertEq(broken, 1);
        assertEq(keptValue, 0);
        assertEq(brokenValue, 9.9 ether);
        _assertSolvent();

        wb.withdraw(sink);
        assertEq(sink.balance, 8.91 ether);
        _assertSolvent();
    }

    function test_challenge_cannotSlashTwice() public {
        uint256 id = _create(10 ether, 10_000, 180 days);
        vm.prank(w1);
        token.transfer(buyer, 1e18);
        vm.prank(challenger);
        wb.challenge(id);
        vm.expectRevert(WordBonds.NotActive.selector);
        wb.challenge(id);
        vm.expectRevert(WordBonds.NotActive.selector);
        wb.release(id);
    }

    function test_sellingWithinTheAllowedShareIsNotABreach() public {
        uint256 id = _create(10 ether, 9_000, 180 days); // promised to keep 90%
        vm.prank(w1);
        token.transfer(buyer, 100_000e18); // sells exactly 10%
        (uint256 held, bool breach,) = wb.check(id);
        assertEq(held, 9_000);
        assertFalse(breach);

        vm.prank(w2);
        token.transfer(buyer, 100e18); // now under 90%
        (, breach,) = wb.check(id);
        assertTrue(breach);
    }

    function test_movingTokensBetweenDeclaredWalletsIsNotABreach() public {
        uint256 id = _create(10 ether, 10_000, 180 days);
        vm.prank(w1);
        token.transfer(w2, 600_000e18);
        (uint256 held, bool breach,) = wb.check(id);
        assertEq(held, 10_000);
        assertFalse(breach);
    }

    function test_buyingMoreNeverHurts() public {
        uint256 id = _create(10 ether, 10_000, 180 days);
        token.mint(w1, 50_000_000e18); // far above baseline, held caps at 65535
        (uint256 held, bool breach,) = wb.check(id);
        assertEq(held, 65_535);
        assertFalse(breach);
        token.mint(w2, type(uint256).max - 60_000_000e18); // absurd balance must not overflow
        (held, breach,) = wb.check(id);
        assertEq(held, 65_535);
        assertFalse(breach);
    }

    function test_tokenThatStopsAnsweringCountsAsSold() public {
        uint256 id = _create(10 ether, 10_000, 180 days);
        token.setMode(MockToken.Mode.Revert);
        (uint256 held, bool breach,) = wb.check(id);
        assertEq(held, 0);
        assertTrue(breach);

        token.setMode(MockToken.Mode.ShortReturn);
        (held, breach,) = wb.check(id);
        assertEq(held, 0);
        assertTrue(breach);

        token.setMode(MockToken.Mode.BurnGas);
        vm.prank(challenger);
        wb.challenge(id);
        assertEq(uint8(_status(id)), uint8(WordBonds.Status.Broken));
    }

    function test_oversizedTokenAnswerIsReadNormally() public {
        uint256 id = _create(10 ether, 10_000, 180 days);
        token.setMode(MockToken.Mode.HugeReturn);
        (uint256 held, bool breach,) = wb.check(id);
        assertEq(held, 10_000);
        assertFalse(breach);
    }

    /// A challenger must not be able to starve the balance read of gas to fake an empty wallet.
    function test_lowGasCanNeverSlashAnHonestMaker() public {
        uint256 id = _create(10 ether, 10_000, 180 days);
        token.setMode(MockToken.Mode.Heavy); // a token whose balance read is expensive but valid
        (uint256 held, bool breach,) = wb.check(id);
        assertEq(held, 10_000);
        assertFalse(breach);
        for (uint256 g = 20_000; g <= 600_000; g += 2_500) {
            vm.prank(challenger);
            try wb.challenge{gas: g}(id) {
                fail("honest maker was slashed");
            } catch {}
            assertEq(uint8(_status(id)), uint8(WordBonds.Status.Active));
        }
        assertEq(challenger.balance, 0);
    }

    // ---------------------------------------------------------------- release

    function test_release_revertsBeforeDeadline() public {
        uint256 id = _create(10 ether, 10_000, 180 days);
        vm.warp(block.timestamp + 180 days - 1);
        vm.expectRevert(WordBonds.NotReleasable.selector);
        wb.release(id);
    }

    function test_release_returnsBondAndRecordsKeptWord() public {
        uint256 id = _create(10 ether, 10_000, 180 days);
        vm.warp(block.timestamp + 180 days);
        uint256 before = maker.balance;

        vm.prank(challenger); // anyone may trigger it, the money still goes to the maker
        wb.release(id);

        assertEq(maker.balance - before, 9.9 ether);
        assertEq(challenger.balance, 0);
        assertEq(uint8(_status(id)), uint8(WordBonds.Status.Kept));
        (uint32 kept, uint32 broken, uint256 keptValue,) = wb.records(maker);
        assertEq(kept, 1);
        assertEq(broken, 0);
        assertEq(keptValue, 9.9 ether);
        _assertSolvent();

        vm.expectRevert(WordBonds.NotActive.selector);
        wb.release(id);
    }

    function test_makerBelowFloorAtDeadlineCannotRelease_andIsStillSlashable() public {
        uint256 id = _create(10 ether, 10_000, 180 days);
        vm.prank(w1);
        token.transfer(buyer, 300_000e18);
        vm.warp(block.timestamp + 181 days);

        vm.expectRevert(WordBonds.NotReleasable.selector);
        wb.release(id);

        vm.prank(challenger);
        wb.challenge(id);
        assertEq(uint8(_status(id)), uint8(WordBonds.Status.Broken));
    }

    // ----------------------------------------------------- processor failures

    function test_contradictoryVerdictMovesNoMoney() public {
        uint256 id = _create(10 ether, 10_000, 180 days);
        proc.setMode(MockProcessor.Mode.BothBits);
        vm.expectRevert(WordBonds.InvalidVerdict.selector);
        wb.challenge(id);
        vm.expectRevert(WordBonds.InvalidVerdict.selector);
        wb.release(id);

        proc.setMode(MockProcessor.Mode.Empty);
        vm.expectRevert(WordBonds.InvalidVerdict.selector);
        wb.challenge(id);

        proc.setMode(MockProcessor.Mode.Revert);
        vm.expectRevert();
        wb.challenge(id);

        assertEq(uint8(_status(id)), uint8(WordBonds.Status.Active));
        _assertSolvent();
    }

    // ------------------------------------------------------------- reentrancy

    function test_makerCannotReenterOnRefund() public {
        Reenterer r = new Reenterer(wb);
        vm.deal(address(this), 20 ether);
        r.create{value: 10 ether}(tpl, address(token), _wallets(), 10_000, uint64(block.timestamp + 30 days));
        uint256 other = _create(5 ether, 10_000, 30 days);
        vm.warp(block.timestamp + 30 days);

        wb.release(r.bondId());

        assertGt(r.attempts(), 0);
        assertEq(r.succeeded(), 0);
        assertEq(r.lastError(), WordBonds.Reentrancy.selector);
        assertEq(address(r).balance, 9.9 ether);
        assertEq(uint8(_status(other)), uint8(WordBonds.Status.Active));
        _assertSolvent();
    }

    function test_challengerCannotReenterOnBounty() public {
        uint256 id = _create(10 ether, 10_000, 180 days);
        uint256 other = _create(5 ether, 10_000, 180 days);
        vm.prank(w1);
        token.transfer(buyer, 1e18);

        Reenterer r = new Reenterer(wb);
        r.doChallenge(id);

        assertGt(r.attempts(), 0);
        assertEq(r.succeeded(), 0);
        assertEq(r.lastError(), WordBonds.Reentrancy.selector);
        assertEq(address(r).balance, 0.99 ether);
        assertEq(uint8(_status(other)), uint8(WordBonds.Status.Active)); // second bond untouched
        _assertSolvent();
    }

    // --------------------------------------------------------------- withdraw

    function test_sinkThatRejectsFundsCannotBlockASlash() public {
        RejectingSink bad = new RejectingSink();
        WordBonds wb2 = new WordBonds(admin, treasury, address(bad), FEE_BPS);
        vm.prank(admin);
        uint32 t = wb2.addTemplate(proc, CIRCUIT_ID);
        vm.prank(maker);
        uint256 id =
            wb2.createBond{value: 10 ether}(t, address(token), _wallets(), 10_000, uint64(block.timestamp + 30 days), "");
        vm.prank(w1);
        token.transfer(buyer, 1e18);

        vm.prank(challenger);
        wb2.challenge(id);

        assertEq(uint8(wb2.getBond(id).status), uint8(WordBonds.Status.Broken));
        assertEq(challenger.balance, 0.99 ether);
        assertEq(wb2.owed(address(bad)), 8.91 ether);
    }

    function test_withdraw_paysOnlyTheOwedAccount() public {
        _create(10 ether, 10_000, 180 days);
        vm.prank(challenger);
        wb.withdraw(treasury);
        assertEq(treasury.balance, 0.1 ether);
        assertEq(challenger.balance, 0);
        vm.expectRevert(WordBonds.NothingOwed.selector);
        wb.withdraw(treasury);
        vm.expectRevert(WordBonds.NothingOwed.selector);
        wb.withdraw(challenger);
        _assertSolvent();
    }

    // ------------------------------------------------------------------- misc

    function test_unknownBondReverts() public {
        vm.expectRevert(WordBonds.UnknownBond.selector);
        wb.check(0);
        vm.expectRevert(WordBonds.UnknownBond.selector);
        wb.getBond(0);
        vm.expectRevert(WordBonds.UnknownBond.selector);
        wb.challenge(0);
        vm.expectRevert(WordBonds.UnknownBond.selector);
        wb.release(0);
    }

    function test_adminHasNoPathToBondFunds() public {
        uint256 id = _create(10 ether, 10_000, 180 days);
        vm.startPrank(admin);
        vm.expectRevert(WordBonds.NotBreached.selector);
        wb.challenge(id);
        vm.expectRevert(WordBonds.NotReleasable.selector);
        wb.release(id);
        vm.expectRevert(WordBonds.NothingOwed.selector);
        wb.withdraw(admin);
        vm.stopPrank();
        assertEq(admin.balance, 0);
    }

    // ------------------------------------------------------------------- fuzz

    /// Whatever the maker sells and whenever anyone acts, exactly one outcome is possible,
    /// it matches the promise, and every unit of money is accounted for.
    function testFuzz_outcomeMatchesPromise(uint96 value, uint16 floorBps, uint256 sold, uint32 wait) public {
        value = uint96(bound(value, 1e6, 50 ether));
        floorBps = uint16(bound(floorBps, 1, 10_000));
        sold = bound(sold, 0, 600_000e18);
        uint64 duration = 30 days;
        wait = uint32(bound(wait, 0, 60 days));

        uint256 id = _create(value, floorBps, duration);
        uint256 amount = wb.getBond(id).amount;
        if (sold != 0) {
            vm.prank(w1);
            token.transfer(buyer, sold);
        }
        vm.warp(block.timestamp + wait);

        uint256 heldBps = ((1_000_000e18 - sold) * 10_000) / 1_000_000e18;
        bool shouldBreach = heldBps < floorBps;
        bool shouldRelease = !shouldBreach && wait >= duration;

        (uint256 held, bool breach, bool releasable) = wb.check(id);
        assertEq(held, heldBps);
        assertEq(breach, shouldBreach);
        assertEq(releasable, shouldRelease);
        assertFalse(breach && releasable);

        uint256 makerBefore = maker.balance;
        if (shouldBreach) {
            vm.expectRevert(WordBonds.NotReleasable.selector);
            wb.release(id);
            vm.prank(challenger);
            wb.challenge(id);
            assertEq(challenger.balance + wb.owed(sink), amount);
            assertEq(maker.balance, makerBefore);
        } else {
            vm.expectRevert(WordBonds.NotBreached.selector);
            wb.challenge(id);
            if (shouldRelease) {
                wb.release(id);
                assertEq(maker.balance - makerBefore, amount);
            } else {
                vm.expectRevert(WordBonds.NotReleasable.selector);
                wb.release(id);
                assertEq(uint8(_status(id)), uint8(WordBonds.Status.Active));
            }
        }
        _assertSolvent();
    }
}
