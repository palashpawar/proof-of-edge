// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {EdgeEscrow} from "../src/EdgeEscrow.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract EdgeEscrowTest is Test {
    EdgeEscrow internal escrow;
    MockUSDC internal usdc;

    address internal owner = makeAddr("owner");
    address internal resolver = makeAddr("resolver");
    address internal buyer = makeAddr("buyer");
    address internal seller;
    uint256 internal sellerKey;

    uint256 internal constant DEPOSIT = 1_000e6;
    uint96 internal constant STAKE = 100e6;
    uint32 internal constant SCALE = 1_000_000;
    string internal constant SYMBOL = "GEMI-BTC05M2611141905-UP";
    bytes32 internal marketId = keccak256(bytes(SYMBOL));
    bytes32 internal constant SALT = keccak256("salt");

    function setUp() public {
        (seller, sellerKey) = makeAddrAndKey("seller");
        usdc = new MockUSDC();
        escrow = new EdgeEscrow(IERC20(address(usdc)), resolver, owner);
        _fund(buyer, DEPOSIT);
        _fund(seller, DEPOSIT);
    }

    // ─────────────────────────────── helpers ────────────────────────────────

    function _fund(address who, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.startPrank(who);
        usdc.approve(address(escrow), amount);
        escrow.deposit(amount);
        vm.stopPrank();
    }

    function _quote(uint32 mRef, uint96 stake, uint32 p, uint256 nonce)
        internal
        view
        returns (EdgeEscrow.Quote memory q)
    {
        q = EdgeEscrow.Quote({
            seller: seller,
            buyer: buyer,
            marketId: marketId,
            mRef: mRef,
            stake: stake,
            expiry: uint64(block.timestamp + 20),
            revealDeadline: uint64(block.timestamp + 60),
            commit: escrow.commitment(marketId, p, SALT),
            nonce: nonce
        });
    }

    function _sign(uint256 key, EdgeEscrow.Quote memory q) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, escrow.hashQuote(q));
        return abi.encodePacked(r, s, v);
    }

    function _open(EdgeEscrow.Quote memory q) internal returns (bytes32 swapId) {
        bytes memory sig = _sign(sellerKey, q);
        vm.prank(buyer);
        swapId = escrow.open(q, sig);
    }

    /// Opens, reveals, resolves and settles one swap; returns the swap id.
    function _cycle(uint32 mRef, uint32 p, uint96 stake, EdgeEscrow.Outcome outcome) internal returns (bytes32 id) {
        id = _open(_quote(mRef, stake, p, 1));
        escrow.reveal(id, p, SALT);
        vm.prank(resolver);
        escrow.resolve(SYMBOL, outcome);
        escrow.settle(id);
    }

    /// Expected edge score times SCALE when the true YES probability is q (exact integer math).
    function _expectedScore(uint32 m, uint32 p, uint32 q) internal view returns (int256) {
        int256 yes = escrow.edgeScore(m, p, true);
        int256 no = escrow.edgeScore(m, p, false);
        return int256(uint256(q)) * yes + int256(uint256(SCALE - q)) * no;
    }

    // ─────────────────────────── happy paths ─────────────────────────────────

    function test_SellerBeatsMarket_BuyerPaysSeller() public {
        // m = 0.50, p = 0.55, YES: Δ = 0.25 − 0.2025 = 0.0475 → 4.75 USDC on a 100 USDC stake
        bytes32 id = _cycle(500_000, 550_000, STAKE, EdgeEscrow.Outcome.Yes);
        assertEq(escrow.balanceOf(seller), DEPOSIT + 4_750_000);
        assertEq(escrow.balanceOf(buyer), DEPOSIT - 4_750_000);
        (,,,,,, EdgeEscrow.Status status,,) = escrow.swaps(id);
        assertEq(uint8(status), uint8(EdgeEscrow.Status.Settled));
    }

    function test_SellerWorseThanMarket_SellerPaysBuyer() public {
        // m = 0.50, p = 0.55, NO: Δ = 0.25 − 0.3025 = −0.0525 → 5.25 USDC to the buyer
        _cycle(500_000, 550_000, STAKE, EdgeEscrow.Outcome.No);
        assertEq(escrow.balanceOf(buyer), DEPOSIT + 5_250_000);
        assertEq(escrow.balanceOf(seller), DEPOSIT - 5_250_000);
    }

    function test_EchoSellerNetsZero() public {
        _cycle(623_000, 623_000, STAKE, EdgeEscrow.Outcome.Yes);
        assertEq(escrow.balanceOf(buyer), DEPOSIT);
        assertEq(escrow.balanceOf(seller), DEPOSIT);
    }

    function test_VoidMarketRefundsBoth() public {
        _cycle(500_000, 900_000, STAKE, EdgeEscrow.Outcome.Void);
        assertEq(escrow.balanceOf(buyer), DEPOSIT);
        assertEq(escrow.balanceOf(seller), DEPOSIT);
    }

    function test_OpenLocksBothStakes() public {
        _open(_quote(500_000, STAKE, 550_000, 1));
        assertEq(escrow.balanceOf(buyer), DEPOSIT - STAKE);
        assertEq(escrow.balanceOf(seller), DEPOSIT - STAKE);
        assertEq(usdc.balanceOf(address(escrow)), 2 * DEPOSIT);
    }

    function test_WithdrawFreeBalance() public {
        vm.prank(buyer);
        escrow.withdraw(DEPOSIT);
        assertEq(usdc.balanceOf(buyer), DEPOSIT);
        assertEq(escrow.balanceOf(buyer), 0);
    }

    // ───────────────────────── reveal timeouts ───────────────────────────────

    function test_ClaimNoReveal_BuyerTakesBothStakes() public {
        EdgeEscrow.Quote memory q = _quote(500_000, STAKE, 550_000, 1);
        bytes32 id = _open(q);
        vm.warp(q.revealDeadline + 1);
        escrow.claimNoReveal(id);
        assertEq(escrow.balanceOf(buyer), DEPOSIT + STAKE);
        assertEq(escrow.balanceOf(seller), DEPOSIT - STAKE);
    }

    function test_RevertWhen_ClaimNoRevealBeforeDeadline() public {
        bytes32 id = _open(_quote(500_000, STAKE, 550_000, 1));
        vm.expectRevert(EdgeEscrow.RevealWindowOpen.selector);
        escrow.claimNoReveal(id);
    }

    function test_RevertWhen_RevealAfterDeadline() public {
        EdgeEscrow.Quote memory q = _quote(500_000, STAKE, 550_000, 1);
        bytes32 id = _open(q);
        vm.warp(q.revealDeadline + 1);
        vm.expectRevert(EdgeEscrow.RevealWindowClosed.selector);
        escrow.reveal(id, 550_000, SALT);
    }

    function test_RefundUnresolvedAfterGrace() public {
        EdgeEscrow.Quote memory q = _quote(500_000, STAKE, 550_000, 1);
        bytes32 id = _open(q);
        escrow.reveal(id, 550_000, SALT);

        vm.warp(uint256(q.revealDeadline) + escrow.RESOLUTION_GRACE());
        vm.expectRevert(EdgeEscrow.GracePeriodActive.selector);
        escrow.refundUnresolved(id);

        vm.warp(uint256(q.revealDeadline) + escrow.RESOLUTION_GRACE() + 1);
        escrow.refundUnresolved(id);
        assertEq(escrow.balanceOf(buyer), DEPOSIT);
        assertEq(escrow.balanceOf(seller), DEPOSIT);
    }

    // ──────────────────────────── open reverts ───────────────────────────────

    function test_RevertWhen_SignedByWrongKey() public {
        EdgeEscrow.Quote memory q = _quote(500_000, STAKE, 550_000, 1);
        (, uint256 otherKey) = makeAddrAndKey("impostor");
        bytes memory sig = _sign(otherKey, q);
        vm.prank(buyer);
        vm.expectRevert(EdgeEscrow.BadSignature.selector);
        escrow.open(q, sig);
    }

    function test_RevertWhen_QuoteTampered() public {
        EdgeEscrow.Quote memory q = _quote(500_000, STAKE, 550_000, 1);
        bytes memory sig = _sign(sellerKey, q);
        q.mRef = 400_000; // buyer tries to move the reference price
        vm.prank(buyer);
        vm.expectRevert(EdgeEscrow.BadSignature.selector);
        escrow.open(q, sig);
    }

    function test_RevertWhen_QuoteExpired() public {
        EdgeEscrow.Quote memory q = _quote(500_000, STAKE, 550_000, 1);
        bytes memory sig = _sign(sellerKey, q);
        vm.warp(q.expiry + 1);
        vm.prank(buyer);
        vm.expectRevert(EdgeEscrow.QuoteExpired.selector);
        escrow.open(q, sig);
    }

    function test_RevertWhen_QuoteReplayed() public {
        EdgeEscrow.Quote memory q = _quote(500_000, STAKE, 550_000, 1);
        bytes memory sig = _sign(sellerKey, q);
        vm.startPrank(buyer);
        escrow.open(q, sig);
        vm.expectRevert(EdgeEscrow.QuoteUsed.selector);
        escrow.open(q, sig);
        vm.stopPrank();
    }

    function test_RevertWhen_OpenedByNonBuyer() public {
        EdgeEscrow.Quote memory q = _quote(500_000, STAKE, 550_000, 1);
        bytes memory sig = _sign(sellerKey, q);
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(EdgeEscrow.NotBuyer.selector);
        escrow.open(q, sig);
    }

    function test_RevertWhen_SellerUnderfunded() public {
        EdgeEscrow.Quote memory q = _quote(500_000, uint96(DEPOSIT + 1), 550_000, 1);
        bytes memory sig = _sign(sellerKey, q);
        _fund(buyer, DEPOSIT); // buyer can cover it, seller cannot
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(EdgeEscrow.InsufficientBalance.selector, seller, DEPOSIT, DEPOSIT + 1));
        escrow.open(q, sig);
    }

    function test_RevertWhen_ReferencePriceOutOfRange() public {
        EdgeEscrow.Quote memory q = _quote(SCALE, STAKE, 550_000, 1);
        bytes memory sig = _sign(sellerKey, q);
        vm.prank(buyer);
        vm.expectRevert(EdgeEscrow.BadPrice.selector);
        escrow.open(q, sig);
    }

    function test_RevertWhen_OpenAfterMarketResolved() public {
        vm.prank(resolver);
        escrow.resolve(SYMBOL, EdgeEscrow.Outcome.Yes);
        EdgeEscrow.Quote memory q = _quote(500_000, STAKE, 550_000, 1);
        bytes memory sig = _sign(sellerKey, q);
        vm.prank(buyer);
        vm.expectRevert(EdgeEscrow.MarketAlreadyResolved.selector);
        escrow.open(q, sig);
    }

    function test_RevertWhen_WithdrawLockedFunds() public {
        _open(_quote(500_000, STAKE, 550_000, 1));
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(EdgeEscrow.InsufficientBalance.selector, buyer, DEPOSIT - STAKE, DEPOSIT)
        );
        escrow.withdraw(DEPOSIT);
    }

    // ───────────────────── reveal / resolve / settle reverts ─────────────────

    function test_RevertWhen_RevealDoesNotMatchCommit() public {
        bytes32 id = _open(_quote(500_000, STAKE, 550_000, 1));
        vm.expectRevert(EdgeEscrow.BadReveal.selector);
        escrow.reveal(id, 560_000, SALT); // seller tries to change its forecast
    }

    function test_RevertWhen_ResolveByNonResolver() public {
        vm.expectRevert(EdgeEscrow.NotResolver.selector);
        escrow.resolve(SYMBOL, EdgeEscrow.Outcome.Yes);
    }

    function test_RevertWhen_ResolvedTwice() public {
        vm.startPrank(resolver);
        escrow.resolve(SYMBOL, EdgeEscrow.Outcome.Yes);
        vm.expectRevert(EdgeEscrow.MarketAlreadyResolved.selector);
        escrow.resolve(SYMBOL, EdgeEscrow.Outcome.No);
        vm.stopPrank();
    }

    function test_RevertWhen_SettleBeforeResolution() public {
        bytes32 id = _open(_quote(500_000, STAKE, 550_000, 1));
        escrow.reveal(id, 550_000, SALT);
        vm.expectRevert(EdgeEscrow.MarketUnresolved.selector);
        escrow.settle(id);
    }

    function test_RevertWhen_SettledTwice() public {
        bytes32 id = _cycle(500_000, 550_000, STAKE, EdgeEscrow.Outcome.Yes);
        vm.expectRevert(abi.encodeWithSelector(EdgeEscrow.WrongStatus.selector, EdgeEscrow.Status.Settled));
        escrow.settle(id);
    }

    function test_OnlyOwnerSetsResolver() public {
        vm.expectRevert();
        escrow.setResolver(makeAddr("x"));
        vm.prank(owner);
        escrow.setResolver(makeAddr("x"));
        assertEq(escrow.resolver(), makeAddr("x"));
    }

    // ───────────────────────────────── fuzz ──────────────────────────────────

    /// Funds are conserved and no one ever moves more than one stake.
    function testFuzz_ConservesFundsAndBoundsPayment(uint32 m, uint32 p, uint96 stake, uint8 rawOutcome) public {
        m = uint32(bound(m, 1, SCALE - 1));
        p = uint32(bound(p, 0, SCALE));
        stake = uint96(bound(stake, 1, DEPOSIT));
        EdgeEscrow.Outcome outcome = EdgeEscrow.Outcome(bound(rawOutcome, 1, 3));

        _cycle(m, p, stake, outcome);

        uint256 b = escrow.balanceOf(buyer);
        uint256 s = escrow.balanceOf(seller);
        assertEq(b + s, 2 * DEPOSIT, "funds not conserved");
        assertEq(usdc.balanceOf(address(escrow)), b + s, "token balance != internal balances");
        assertLe(b > DEPOSIT ? b - DEPOSIT : DEPOSIT - b, stake, "payment exceeds stake");
    }

    /// The score is proper: for any true probability q, reporting p = q maximises the expected score,
    /// and the gap is exactly SCALE·(p − q)².
    function testFuzz_TruthfulReportingIsOptimal(uint32 m, uint32 q, uint32 p) public view {
        m = uint32(bound(m, 1, SCALE - 1));
        q = uint32(bound(q, 0, SCALE));
        p = uint32(bound(p, 0, SCALE));

        int256 truthful = _expectedScore(m, q, q);
        int256 other = _expectedScore(m, p, q);
        int256 gap = int256(uint256(p)) - int256(uint256(q));
        assertEq(truthful - other, int256(uint256(SCALE)) * gap * gap);
    }

    /// A truthful seller's expected score is SCALE·(m − q)²: zero exactly when it knows nothing beyond the market.
    function testFuzz_TruthfulPayoffIsMarketGap(uint32 m, uint32 q) public view {
        m = uint32(bound(m, 1, SCALE - 1));
        q = uint32(bound(q, 0, SCALE));
        int256 gap = int256(uint256(m)) - int256(uint256(q));
        assertEq(_expectedScore(m, q, q), int256(uint256(SCALE)) * gap * gap);
    }
}
