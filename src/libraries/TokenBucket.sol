// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Capacity/refill budget. `tokens` is the amount that can be consumed now; it refills linearly at `rate`
/// tokens per second up to `capacity`.
/// @dev Usage is never reset: reconfiguration keeps the current (refilled) balance, capped at the new capacity. Only a
/// bucket's first configuration starts it full.
library TokenBucket {
  struct Bucket {
    uint256 capacity;
    uint256 rate;
    uint256 tokens;
    uint256 lastUpdated;
    bool initialized;
  }

  error BudgetExceeded(uint256 requested, uint256 available);

  /// @notice Returns the amount that can be consumed at the current block.
  function available(Bucket storage bucket) internal view returns (uint256) {
    return _refill(bucket.capacity, bucket.tokens, block.timestamp - bucket.lastUpdated, bucket.rate);
  }

  /// @notice Consumes `amount`, reverting if it exceeds the available amount.
  function consume(Bucket storage bucket, uint256 amount) internal {
    uint256 tokens = available(bucket);
    if (amount > tokens) revert BudgetExceeded(amount, tokens);
    bucket.tokens = tokens - amount;
    bucket.lastUpdated = block.timestamp;
  }

  /// @notice Applies a new capacity and refill rate. Time elapsed so far is refilled under the old rate, then the
  /// balance is capped at the new capacity. A bucket that has never been configured starts full.
  function setConfig(Bucket storage bucket, uint256 capacity, uint256 rate) internal {
    uint256 tokens;
    if (bucket.initialized) {
      tokens = available(bucket);
      if (tokens > capacity) tokens = capacity;
    } else {
      tokens = capacity;
      bucket.initialized = true;
    }
    bucket.capacity = capacity;
    bucket.rate = rate;
    bucket.tokens = tokens;
    bucket.lastUpdated = block.timestamp;
  }

  function _refill(uint256 capacity, uint256 tokens, uint256 elapsed, uint256 rate) private pure returns (uint256) {
    if (tokens >= capacity) return capacity;
    if (rate == 0) return tokens;
    uint256 deficit = capacity - tokens;
    // Past this point `elapsed * rate <= deficit`, so neither the product nor the sum can overflow.
    if (elapsed > deficit / rate) return capacity;
    return tokens + elapsed * rate;
  }
}
