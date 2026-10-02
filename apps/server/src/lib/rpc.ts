/**
 * Onchain reads for agent tools, with sanitized errors (SEC-7). Same API as lib/evm.ts, but a failure never carries
 * the RPC URL (which can hold an API key) into the model's context, run events or logs.
 */
import { inspectAddress as inspect, readFunction as read } from "./evm.ts";
import { rpcErrorMessage } from "./redact.ts";

export { SUPPORTED_CHAINS } from "./evm.ts";

export async function inspectAddress(chainId: number, addr: string): Promise<string> {
  try {
    return await inspect(chainId, addr);
  } catch (e) {
    throw new Error(rpcErrorMessage(chainId, e));
  }
}

export async function readFunction(chainId: number, addr: string, signature: string, args: string[]): Promise<string> {
  try {
    return await read(chainId, addr, signature, args);
  } catch (e) {
    throw new Error(rpcErrorMessage(chainId, e));
  }
}
