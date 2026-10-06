import { describe, expect, it } from 'vitest';
import { encodeErrorResult, RpcRequestError } from 'viem';
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
