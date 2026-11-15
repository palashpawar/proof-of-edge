// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {EdgeEscrow} from "../src/EdgeEscrow.sol";

/// Deploys EdgeEscrow to Arc Testnet.
///
///   set -a; source ../.env; set +a
///   forge script script/Deploy.s.sol --rpc-url arc_testnet --broadcast --with-gas-price 25gwei
///
/// Arc silently drops transactions with maxFeePerGas below 20 gwei, hence --with-gas-price.
contract Deploy is Script {
    address internal constant ARC_USDC = 0x3600000000000000000000000000000000000000;

    function run() external returns (EdgeEscrow escrow) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address resolver = vm.envAddress("RESOLVER_ADDRESS");
        address usdc = vm.envOr("USDC_ADDRESS", ARC_USDC);
        address owner = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);
        escrow = new EdgeEscrow(IERC20(usdc), resolver, owner);
        vm.stopBroadcast();

        console2.log("EdgeEscrow:", address(escrow));
        console2.log("owner:     ", owner);
        console2.log("resolver:  ", resolver);
        console2.log("usdc:      ", usdc);
    }
}
