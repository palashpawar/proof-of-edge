// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title EdgeEscrow
/// @notice Settles "edge swaps" between a forecast buyer and a forecast seller.
///
///         For one binary prediction-market contract, the seller signs a quote that fixes
///         the market reference probability `m` (the YES mid when the quote was made) and a
///         hash commitment to its own forecast `p`. The buyer opens the swap, which locks the
///         same `stake` from both sides. The seller then reveals `p`. When the market resolves
///         to outcome `y`, the edge score is the Brier improvement over the market:
///
///             Δ = (m − y)² − (p − y)²            Δ ∈ [−1, 1]
///
///         If Δ > 0 the buyer pays the seller `stake·Δ`; if Δ < 0 the seller pays the buyer
///         `stake·|Δ|`. Because the payoff is linear in a proper scoring rule, reporting the
///         true belief maximises the seller's expected payoff, and a seller that just echoes
///         the market (p = m) always nets exactly zero.
///
/// @dev    Probabilities are parts per million (SCALE = 1e6). Stakes are in the ERC-20 units
///         of `usdc` (6 decimals for USDC on Arc via 0x3600…0000). Funds move only between
///         internal balances during a swap; tokens leave the contract only via `withdraw`.
contract EdgeEscrow is EIP712, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─────────────────────────────── constants ───────────────────────────────

    uint32 public constant SCALE = 1_000_000;
    int256 private constant SCALE_SQ = 1e12;

    /// @notice After a swap's reveal deadline, if its market is still unresolved this long,
    ///         either party can refund both stakes. Guards against a dead resolver.
    uint64 public constant RESOLUTION_GRACE = 7 days;

    bytes32 public constant QUOTE_TYPEHASH = keccak256(
        "Quote(address seller,address buyer,bytes32 marketId,uint32 mRef,uint96 stake,uint64 expiry,uint64 revealDeadline,bytes32 commit,uint256 nonce)"
    );

    // ───────────────────────────────── types ─────────────────────────────────

    enum Outcome {
        Unresolved,
        No,
        Yes,
        Void
    }

    enum Status {
        None,
        Open,
        Revealed,
        Settled
    }

    /// @notice Signed by the seller, submitted by the buyer.
    /// @param marketId       keccak256 of the Gemini instrument symbol, e.g. "GEMI-BTC05M2611141905-UP".
    /// @param mRef           market YES probability (ppm) the edge is measured against.
    /// @param stake          amount each side locks.
    /// @param expiry         last timestamp at which the buyer may open the swap.
    /// @param revealDeadline last timestamp at which the forecast may be revealed.
    /// @param commit         commitment(marketId, p, salt).
    /// @param nonce          seller-chosen; makes otherwise identical quotes distinct.
    struct Quote {
        address seller;
        address buyer;
        bytes32 marketId;
        uint32 mRef;
        uint96 stake;
        uint64 expiry;
        uint64 revealDeadline;
        bytes32 commit;
        uint256 nonce;
    }

    struct Swap {
        address buyer;
        uint96 stake;
        address seller;
        uint64 revealDeadline;
        uint32 mRef;
        uint32 p;
        Status status;
        bytes32 marketId;
        bytes32 commit;
    }

    // ──────────────────────────────── storage ────────────────────────────────

    IERC20 public immutable usdc;
    address public resolver;

    /// @notice Free (unlocked) balance per account.
    mapping(address account => uint256) public balanceOf;
    /// @notice Swaps keyed by the EIP-712 digest of their quote.
    mapping(bytes32 swapId => Swap) public swaps;
    /// @notice Resolution per market.
    mapping(bytes32 marketId => Outcome) public outcomes;

    // ──────────────────────────────── events ─────────────────────────────────

    event Deposited(address indexed account, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);
    event ResolverChanged(address indexed previous, address indexed current);
    event SwapOpened(
        bytes32 indexed swapId,
        bytes32 indexed marketId,
        address indexed seller,
        address buyer,
        uint32 mRef,
        uint96 stake,
        uint64 revealDeadline,
        bytes32 commit
    );
    event ForecastRevealed(bytes32 indexed swapId, address indexed seller, uint32 p);
    event MarketResolved(bytes32 indexed marketId, Outcome outcome, string instrumentSymbol);
    event SwapSettled(
        bytes32 indexed swapId,
        address indexed seller,
        address indexed buyer,
        Outcome outcome,
        int256 edgeScore,
        uint256 payment
    );
    event SwapForfeited(bytes32 indexed swapId, address indexed seller, address indexed buyer, uint256 penalty);
    event SwapRefunded(bytes32 indexed swapId);

    // ──────────────────────────────── errors ─────────────────────────────────

    error NotBuyer();
    error NotResolver();
    error SelfSwap();
    error ZeroAmount();
    error ZeroAddress();
    error BadPrice();
    error BadOutcome();
    error QuoteExpired();
    error BadDeadline();
    error QuoteUsed();
    error BadSignature();
    error InsufficientBalance(address account, uint256 available, uint256 needed);
    error WrongStatus(Status actual);
    error RevealWindowClosed();
    error RevealWindowOpen();
    error BadReveal();
    error MarketAlreadyResolved();
    error MarketUnresolved();
    error GracePeriodActive();

    // ───────────────────────────── construction ──────────────────────────────

    constructor(IERC20 usdc_, address resolver_, address owner_) EIP712("EdgeEscrow", "1") Ownable(owner_) {
        if (address(usdc_) == address(0) || resolver_ == address(0)) revert ZeroAddress();
        usdc = usdc_;
        resolver = resolver_;
        emit ResolverChanged(address(0), resolver_);
    }

    function setResolver(address resolver_) external onlyOwner {
        if (resolver_ == address(0)) revert ZeroAddress();
        emit ResolverChanged(resolver, resolver_);
        resolver = resolver_;
    }

    // ─────────────────────────────── balances ────────────────────────────────

    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        balanceOf[msg.sender] += amount;
        emit Deposited(msg.sender, amount);
    }

    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _debit(msg.sender, amount);
        usdc.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    // ───────────────────────────── swap lifecycle ────────────────────────────

    /// @notice Buyer opens a swap from a seller-signed quote. Locks `q.stake` from both sides.
    /// @param signature ECDSA signature, or ERC-1271 for smart-contract sellers.
    /// @return swapId the quote's EIP-712 digest.
    function open(Quote calldata q, bytes calldata signature) external returns (bytes32 swapId) {
        if (msg.sender != q.buyer) revert NotBuyer();
        if (q.seller == q.buyer) revert SelfSwap();
        if (q.stake == 0) revert ZeroAmount();
        if (q.mRef == 0 || q.mRef >= SCALE) revert BadPrice();
        if (block.timestamp > q.expiry) revert QuoteExpired();
        if (q.revealDeadline <= block.timestamp) revert BadDeadline();
        if (outcomes[q.marketId] != Outcome.Unresolved) revert MarketAlreadyResolved();

        swapId = hashQuote(q);
        if (swaps[swapId].status != Status.None) revert QuoteUsed();
        if (!SignatureChecker.isValidSignatureNow(q.seller, swapId, signature)) revert BadSignature();

        _debit(q.buyer, q.stake);
        _debit(q.seller, q.stake);

        swaps[swapId] = Swap({
            buyer: q.buyer,
            stake: q.stake,
            seller: q.seller,
            revealDeadline: q.revealDeadline,
            mRef: q.mRef,
            p: 0,
            status: Status.Open,
            marketId: q.marketId,
            commit: q.commit
        });

        emit SwapOpened(swapId, q.marketId, q.seller, q.buyer, q.mRef, q.stake, q.revealDeadline, q.commit);
    }

    /// @notice Reveals the committed forecast. Callable by anyone holding `p` and `salt`.
    function reveal(bytes32 swapId, uint32 p, bytes32 salt) external {
        Swap storage s = swaps[swapId];
        if (s.status != Status.Open) revert WrongStatus(s.status);
        if (block.timestamp > s.revealDeadline) revert RevealWindowClosed();
        if (p > SCALE) revert BadPrice();
        if (commitment(s.marketId, p, salt) != s.commit) revert BadReveal();

        s.p = p;
        s.status = Status.Revealed;
        emit ForecastRevealed(swapId, s.seller, p);
    }

    /// @notice Records a market's outcome. Resolver only, once per market.
    /// @param instrumentSymbol the Gemini instrument symbol; marketId = keccak256(bytes(instrumentSymbol)).
    function resolve(string calldata instrumentSymbol, Outcome outcome) external {
        if (msg.sender != resolver) revert NotResolver();
        if (outcome == Outcome.Unresolved) revert BadOutcome();
        bytes32 marketId = keccak256(bytes(instrumentSymbol));
        if (outcomes[marketId] != Outcome.Unresolved) revert MarketAlreadyResolved();

        outcomes[marketId] = outcome;
        emit MarketResolved(marketId, outcome, instrumentSymbol);
    }

    /// @notice Settles a revealed swap whose market has resolved. Callable by anyone.
    function settle(bytes32 swapId) external {
        Swap storage s = swaps[swapId];
        if (s.status != Status.Revealed) revert WrongStatus(s.status);
        Outcome outcome = outcomes[s.marketId];
        if (outcome == Outcome.Unresolved) revert MarketUnresolved();

        s.status = Status.Settled;
        uint256 stake = s.stake;

        if (outcome == Outcome.Void) {
            balanceOf[s.buyer] += stake;
            balanceOf[s.seller] += stake;
            emit SwapSettled(swapId, s.seller, s.buyer, outcome, 0, 0);
            return;
        }

        int256 delta = edgeScore(s.mRef, s.p, outcome == Outcome.Yes);
        uint256 payment = (stake * uint256(delta >= 0 ? delta : -delta)) / uint256(SCALE_SQ);

        if (delta > 0) {
            balanceOf[s.seller] += stake + payment;
            balanceOf[s.buyer] += stake - payment;
        } else {
            balanceOf[s.buyer] += stake + payment;
            balanceOf[s.seller] += stake - payment;
        }
        emit SwapSettled(swapId, s.seller, s.buyer, outcome, delta, payment);
    }

    /// @notice If the seller never revealed, the buyer takes both stakes once the deadline passes.
    ///         The penalty (one full stake) is at least the most the seller could lose by revealing,
    ///         so withholding a forecast never pays.
    function claimNoReveal(bytes32 swapId) external {
        Swap storage s = swaps[swapId];
        if (s.status != Status.Open) revert WrongStatus(s.status);
        if (block.timestamp <= s.revealDeadline) revert RevealWindowOpen();

        s.status = Status.Settled;
        balanceOf[s.buyer] += 2 * uint256(s.stake);
        emit SwapForfeited(swapId, s.seller, s.buyer, s.stake);
    }

    /// @notice Refunds both stakes if the market is still unresolved long after the reveal deadline.
    function refundUnresolved(bytes32 swapId) external {
        Swap storage s = swaps[swapId];
        if (s.status != Status.Revealed) revert WrongStatus(s.status);
        if (outcomes[s.marketId] != Outcome.Unresolved) revert MarketAlreadyResolved();
        if (block.timestamp <= uint256(s.revealDeadline) + RESOLUTION_GRACE) revert GracePeriodActive();

        s.status = Status.Settled;
        balanceOf[s.buyer] += s.stake;
        balanceOf[s.seller] += s.stake;
        emit SwapRefunded(swapId);
    }

    // ────────────────────────────────── views ────────────────────────────────

    /// @notice Brier improvement of forecast `p` over market `m` for the realised outcome, scaled by 1e12.
    function edgeScore(uint32 m, uint32 p, bool yes) public pure returns (int256) {
        int256 y = yes ? int256(uint256(SCALE)) : int256(0);
        int256 dm = int256(uint256(m)) - y;
        int256 dp = int256(uint256(p)) - y;
        return dm * dm - dp * dp;
    }

    function commitment(bytes32 marketId, uint32 p, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(marketId, p, salt));
    }

    function hashQuote(Quote calldata q) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    QUOTE_TYPEHASH,
                    q.seller,
                    q.buyer,
                    q.marketId,
                    q.mRef,
                    q.stake,
                    q.expiry,
                    q.revealDeadline,
                    q.commit,
                    q.nonce
                )
            )
        );
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ──────────────────────────────── internal ───────────────────────────────

    function _debit(address account, uint256 amount) private {
        uint256 available = balanceOf[account];
        if (available < amount) revert InsufficientBalance(account, available, amount);
        unchecked {
            balanceOf[account] = available - amount;
        }
    }
}
