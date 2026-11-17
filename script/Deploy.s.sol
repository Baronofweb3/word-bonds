// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {WordBonds} from "../src/WordBonds.sol";
import {ITapeOutProcessor} from "../src/ITapeOutProcessor.sol";

/// Deploys Word Bonds and registers the hold-rule circuit as template 0.
/// Needs: ADMIN, TREASURY, SLASH_SINK, FEE_BPS, PROCESSOR, CIRCUIT_ID.
contract Deploy is Script {
    function run() external {
        address admin = vm.envAddress("ADMIN");
        vm.startBroadcast();
        WordBonds wb = new WordBonds(msg.sender, vm.envAddress("TREASURY"), vm.envAddress("SLASH_SINK"), vm.envUint("FEE_BPS"));
        wb.addTemplate(ITapeOutProcessor(vm.envAddress("PROCESSOR")), vm.envUint("CIRCUIT_ID"));
        if (admin != msg.sender) wb.transferAdmin(admin);
        vm.stopBroadcast();
        console.log("WordBonds:", address(wb));
    }
}
