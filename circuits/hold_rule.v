// Word Bonds rule #1: "the declared wallets keep holding".
//
//   held    current holdings of the declared wallets, in basis points of the
//           amount they held when the bond was created (capped at 65535)
//   floor   the share the maker promised to keep, in basis points
//   expired 1 once the promise's end date has passed
//
//   breach  1 whenever holdings are under the promised floor -> bond is slashed
//   release 1 only when the end date has passed AND the floor is still met
//
// The two outputs can never both be 1.
module hold_rule(
  input  [15:0] held,
  input  [15:0] floor,
  input         expired,
  output        breach,
  output        release
);
  assign breach  = held < floor;
  assign release = expired && !(held < floor);
endmodule
