// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TokenBucket} from "src/libraries/TokenBucket.sol";

/// @notice Exposes the internal `TokenBucket` library on a single storage bucket.
contract TokenBucketHarness {
  using TokenBucket for TokenBucket.Bucket;

  TokenBucket.Bucket internal s_bucket;

  function available() external view returns (uint256) {
    return s_bucket.available();
  }

  function consume(uint256 amount) external {
    s_bucket.consume(amount);
  }

  function setConfig(uint256 capacity, uint256 rate) external {
    s_bucket.setConfig(capacity, rate);
  }

  function raw() external view returns (TokenBucket.Bucket memory) {
    return s_bucket;
  }
}
