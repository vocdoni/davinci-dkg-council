import { describe, expect, it } from 'vitest';
import { encodeErrorResult, HttpRequestError, InvalidParamsRpcError, RpcRequestError } from 'viem';
import { isBehindHead, isTransientReadError } from '../src/broadcast.js';
import { decodeRevert, extractRevertData, isRevert, RelayError, revertName, simulationError } from '../src/errors.js';

const errorData = (name: string) => encodeErrorResult({ abi: [{ type: 'error', name, inputs: [] }], errorName: name });

describe('revert decoding', () => {
  it('decodes SDK-ABI and supplementary manager errors, Error(string) and unknown selectors', () => {
    expect(decodeRevert(errorData('WrongPhase'))).toBe('WrongPhase()');
    for (const name of ['BadThreshold', 'BadDuration', 'NoInvites', 'RosterFull', 'AlreadyListed']) {
      expect(decodeRevert(errorData(name))).toBe(`${name}()`);
    }
    const errorString = encodeErrorResult({
      abi: [{ type: 'error', name: 'Error', inputs: [{ name: 'message', type: 'string' }] }],
      errorName: 'Error',
      args: ['boom'],
    });
    expect(decodeRevert(errorString)).toBe('Error(boom)');
    expect(decodeRevert('0xdeadbeef')).toBe('unknown revert 0xdeadbeef');
    expect(decodeRevert('0x')).toBe('reverted without data');
  });

  it('finds revert data nested in the cause chain and classifies reverts', () => {
    const rpc = new RpcRequestError({ body: {}, error: { code: 3, message: 'execution reverted', data: errorData('AlreadyListed') }, url: 'x' });
    const wrapped = new Error('call failed', { cause: new Error('inner', { cause: rpc }) });
    expect(extractRevertData(wrapped)).toBe(errorData('AlreadyListed'));
    expect(isRevert(wrapped)).toBe(true);
    expect(revertName(wrapped)).toBe('AlreadyListed');
    const e = simulationError(wrapped);
    expect(e).toBeInstanceOf(RelayError);
    expect(e.toJSON()).toEqual({ error: 'SIMULATION_REVERTED', detail: 'AlreadyListed()', revertData: errorData('AlreadyListed') });
    expect(isRevert(new Error('ECONNREFUSED'))).toBe(false);
  });
});

describe('read failures on public RPCs', () => {
  const rpc = (code: number, message: string, data?: `0x${string}`) =>
    new RpcRequestError({ body: {}, error: { code, message, data }, url: 'https://rpc.example' });

  it('a log range past a lagging backend\'s head is transient, not an invalid request', () => {
    // What publicnode and Tenderly answer when eth_getLogs reaches past the head they serve.
    const err = new InvalidParamsRpcError(rpc(-32602, 'block range extends beyond current head block: requested 11856980, head 11856979'));
    expect(isBehindHead(err)).toBe(true);
    expect(isTransientReadError(err)).toBe(true);
    expect(isBehindHead(new InvalidParamsRpcError(rpc(-32602, 'invalid argument 0: hex string without 0x prefix')))).toBe(false);
    expect(isTransientReadError(new InvalidParamsRpcError(rpc(-32602, 'invalid argument 0')))).toBe(false);
  });

  it('rate limits, timeouts and 5xx are transient; reverts and endpoint refusals are not', () => {
    expect(isTransientReadError(new HttpRequestError({ url: 'https://rpc.example', status: 429, details: 'Too Many Requests' }))).toBe(true);
    expect(isTransientReadError(new HttpRequestError({ url: 'https://rpc.example', status: 503 }))).toBe(true);
    expect(isTransientReadError(rpc(-32005, 'limit exceeded'))).toBe(true);
    expect(isTransientReadError(rpc(3, 'execution reverted', errorData('UnknownCeremony')))).toBe(false);
    expect(isTransientReadError(rpc(-32601, 'the method eth_getLogs does not exist/is not available'))).toBe(false);
    expect(isTransientReadError(new HttpRequestError({ url: 'https://rpc.example', status: 401 }))).toBe(false);
  });
});
