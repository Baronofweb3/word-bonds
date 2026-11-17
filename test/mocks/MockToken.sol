// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Minimal token with switches for hostile behaviour.
contract MockToken {
    enum Mode {
        Normal,
        Revert,
        BurnGas,
        ShortReturn,
        HugeReturn,
        Heavy
    }

    Mode public mode;
    mapping(address => uint256) private _bal;

    function setMode(Mode m) external {
        mode = m;
    }

    function mint(address to, uint256 v) external {
        _bal[to] += v;
    }

    function transfer(address to, uint256 v) external returns (bool) {
        _bal[msg.sender] -= v;
        _bal[to] += v;
        return true;
    }

    function balanceOf(address a) external view returns (uint256) {
        if (mode == Mode.Revert) revert("no");
        if (mode == Mode.BurnGas) {
            uint256 x;
            while (true) x = uint256(keccak256(abi.encode(x)));
        }
        if (mode == Mode.ShortReturn) {
            assembly {
                mstore(0, 1)
                return(0, 16)
            }
        }
        if (mode == Mode.HugeReturn) {
            uint256 b = _bal[a];
            assembly {
                mstore(0, b)
                return(0, 40000)
            }
        }
        if (mode == Mode.Heavy) {
            uint256 x;
            uint256 start = gasleft();
            while (start - gasleft() < 80_000) x = uint256(keccak256(abi.encode(x)));
        }
        return _bal[a];
    }
}
