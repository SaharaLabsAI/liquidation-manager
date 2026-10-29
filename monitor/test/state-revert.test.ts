// decodeRevert against the errors a real viem client throws (custom transport: no network).
import {createPublicClient, custom, encodeErrorResult, type Address} from "viem";
import {describe, expect, it} from "vitest";

import {tokenPoolAbi} from "../src/abi/external.ts";
import {liquidityManagerAbi} from "../src/abi/generated.ts";
import {decodeRevert} from "../src/rules/state.ts";
import {A} from "./helpers/state-deployment.ts";

/** readContract(verifyAdapter) through a transport whose eth_call fails with `rpcError`; returns what it threw. */
async function thrownBy(rpcError: unknown): Promise<unknown> {
  const client = createPublicClient({
    transport: custom(
      {
        request: async () => {
          throw rpcError;
        },
      },
      {retryCount: 0},
    ),
  });
  try {
    await client.readContract({
      address: A.manager,
      abi: liquidityManagerAbi,
      functionName: "verifyAdapter",
      args: [1n],
      blockNumber: 5n,
    });
  } catch (error) {
    return error;
  }
  throw new Error("readContract did not throw");
}

const label = (address: Address) => (address === A.pool ? "Pool" : address);

describe("decodeRevert with viem readContract errors", () => {
  it("decodes a Manager custom error with argument names and labels", async () => {
    const data = encodeErrorResult({
      abi: liquidityManagerAbi,
      errorName: "PoolRebalancerMismatch",
      args: [A.pool, A.stranger],
    });
    const error = await thrownBy({code: 3, message: "execution reverted", data});
    expect(decodeRevert(error, label)).toEqual({
      name: "PoolRebalancerMismatch",
      text: `PoolRebalancerMismatch(pool = Pool ${A.pool}, rebalancer = ${A.stranger})`,
    });
  });

  it("decodes a pool error bubbled through the Manager (not in the Manager ABI)", async () => {
    const data = encodeErrorResult({abi: tokenPoolAbi, errorName: "ChainNotAllowed", args: [5n]});
    const error = await thrownBy({code: 3, message: "execution reverted", data});
    expect(decodeRevert(error, label)).toEqual({
      name: "ChainNotAllowed",
      text: "ChainNotAllowed(remoteChainSelector = 5)",
    });
  });

  it("treats a revert without data as a revert (code 3 and geth's -32000)", async () => {
    for (const rpcError of [
      {code: 3, message: "execution reverted"},
      {code: -32000, message: "execution reverted"},
    ]) {
      expect(decodeRevert(await thrownBy(rpcError), label)?.name).toBe("empty revert");
    }
  });

  it("returns undefined for node and transport failures", async () => {
    expect(decodeRevert(await thrownBy({code: -32603, message: "header not found"}), label)).toBeUndefined();
    expect(decodeRevert(await thrownBy(new Error("fetch failed")), label)).toBeUndefined();
  });
});
